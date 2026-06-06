const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const MAX_CHANNELS = 5; // canais que cada conta pode conectar

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
].join(' ');

// ── Criptografia do refresh_token (AES-256-GCM) ──
function encKey() {
  const raw = process.env.TOKEN_ENC_KEY || '';
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(raw).digest();
}
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}
function decrypt(blob) {
  const [ivB, tagB, dataB] = String(blob).split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()]).toString('utf8');
}

// Renova o access_token a partir do refresh_token
async function getAccessToken(refreshToken) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const d = await r.json();
  return d.access_token || null;
}

function parseDuration(isoStr) {
  const m = (isoStr || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return { durationStr: '', totalSec: 0 };
  const h = parseInt(m[1]) || 0, min = parseInt(m[2]) || 0, s = parseInt(m[3]) || 0;
  const totalSec = h * 3600 + min * 60 + s;
  const durationStr = h ? `${h}:${String(min).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${min}:${String(s).padStart(2,'0')}`;
  return { durationStr, totalSec };
}

// Detecta padrões nos títulos (quais elementos os melhores vídeos usam)
function analyzeTitles(titles) {
  if (!titles.length) return null;
  const n = titles.length;
  const pct = c => Math.round((c / n) * 100);
  let withNum = 0, withQuestion = 0, withEmoji = 0, withBracket = 0, withCaps = 0, lenSum = 0;
  const emojiRe = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
  const freq = {};
  const stop = new Set(['de','a','o','e','que','do','da','em','um','uma','para','com','no','na','os','as','por','se','the','to','of','and','my','i','you','is','it','how','el','la','los','las','un','con','su']);
  titles.forEach(t => {
    lenSum += t.length;
    if (/\d/.test(t)) withNum++;
    if (t.includes('?')) withQuestion++;
    if (emojiRe.test(t)) withEmoji++;
    if (/[\[\]\(\)]/.test(t)) withBracket++;
    if (/\b[A-ZÀ-Ý]{3,}\b/.test(t)) withCaps++;
    t.toLowerCase().replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).forEach(w => {
      if (w.length >= 4 && !stop.has(w)) freq[w] = (freq[w] || 0) + 1;
    });
  });
  const topWords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 12).map(x => x[0]);
  return {
    avgLength: Math.round(lenSum / n),
    pctNumber: pct(withNum), pctQuestion: pct(withQuestion),
    pctEmoji: pct(withEmoji), pctBracket: pct(withBracket), pctCaps: pct(withCaps),
    topWords,
  };
}

const fmt = num => num >= 1000000 ? (num / 1000000).toFixed(1) + 'M' : num >= 1000 ? (num / 1000).toFixed(1) + 'K' : String(num || 0);

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri)
    return res.status(500).json({ error: 'OAuth não configurado no servidor.' });

  const { action = '', channel_id = '' } = req.query;

  // ── CALLBACK: troca código por tokens e salva o canal (não usa Bearer) ──
  if (action === 'callback') {
    const { code, state, error: oauthErr } = req.query;
    const back = (msg) => res.redirect(`/dashboard.html#canais${msg ? '=' + encodeURIComponent(msg) : ''}`);
    if (oauthErr) return back('cancelado');
    if (!code || !state) return back('erro');

    let uid;
    try { uid = jwt.verify(state, process.env.JWT_SECRET).uid; }
    catch { return back('expirado'); }

    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, client_id: clientId, client_secret: clientSecret,
          redirect_uri: redirectUri, grant_type: 'authorization_code',
        }),
      });
      const tokens = await tokenRes.json();
      if (!tokens.access_token) { console.error('[oauth/callback]', JSON.stringify(tokens)); return back('erro_token'); }
      if (!tokens.refresh_token) return back('sem_refresh');

      const chRes = await fetch(
        'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
        { headers: { Authorization: `Bearer ${tokens.access_token}` } }
      );
      const chData = await chRes.json();
      const ch = chData.items?.[0];
      if (!ch) return back('sem_canal');

      const { data: existing } = await supabase.from('yt_channels').select('channel_id').eq('user_id', uid);
      const already = (existing || []).some(c => c.channel_id === ch.id);
      if (!already && (existing || []).length >= MAX_CHANNELS) return back('limite_canais');

      await supabase.from('yt_channels').upsert({
        user_id: uid,
        channel_id: ch.id,
        channel_title: ch.snippet?.title || '',
        channel_thumb: ch.snippet?.thumbnails?.default?.url || '',
        refresh_token: encrypt(tokens.refresh_token),
        connected_at: new Date().toISOString(),
      }, { onConflict: 'user_id,channel_id' });

      return back('conectado');
    } catch (e) {
      console.error('[oauth/callback]', e.message);
      return back('erro');
    }
  }

  // ── Demais actions exigem login (Bearer) ──
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer '))
    return res.status(401).json({ error: 'Não autorizado' });
  let user;
  try { user = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Token inválido' }); }
  const uid = user.sub || user.id;

  // ── INÍCIO DO LOGIN: gera a URL de consentimento do Google ──
  if (action === 'login') {
    const state = jwt.sign({ uid }, process.env.JWT_SECRET, { expiresIn: '10m' });
    const params = new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
      scope: SCOPES, access_type: 'offline', prompt: 'consent',
      include_granted_scopes: 'true', state,
    });
    return res.status(200).json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
  }

  // ── LISTA os canais conectados (sem expor o refresh_token) ──
  if (action === 'list') {
    const { data } = await supabase
      .from('yt_channels')
      .select('channel_id, channel_title, channel_thumb, connected_at, last_analyzed_at')
      .eq('user_id', uid).order('connected_at', { ascending: true });
    return res.status(200).json({ channels: data || [] });
  }

  // ── DESCONECTA um canal ──
  if (action === 'disconnect') {
    if (!channel_id) return res.status(400).json({ error: 'channel_id obrigatório' });
    await supabase.from('yt_channels').delete().eq('user_id', uid).eq('channel_id', channel_id);
    return res.status(200).json({ ok: true });
  }

  // ── RELATÓRIO completo do canal + prompt pra IA ──
  if (action === 'report') {
    if (!channel_id) return res.status(400).json({ error: 'channel_id obrigatório' });
    try {
      const { data: row } = await supabase
        .from('yt_channels').select('*')
        .eq('user_id', uid).eq('channel_id', channel_id).single();
      if (!row) return res.status(404).json({ error: 'Canal não encontrado.' });

      const accessToken = await getAccessToken(decrypt(row.refresh_token));
      if (!accessToken) return res.status(401).json({ error: 'Autorização expirada. Reconecte o canal.' });
      const authH = { Authorization: `Bearer ${accessToken}` };

      const today = new Date();
      const start = new Date(today.getTime() - 30 * 86400000);
      const fmtDate = d => d.toISOString().split('T')[0];

      // 1. Analytics — métricas gerais (30 dias)
      const aParams = new URLSearchParams({
        ids: 'channel==MINE', startDate: fmtDate(start), endDate: fmtDate(today),
        metrics: 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,likes',
      });
      const aRes = await fetch(`https://youtubeanalytics.googleapis.com/v2/reports?${aParams}`, { headers: authH });
      const aData = await aRes.json();
      const aRow = aData.rows?.[0] || [];
      const cols = (aData.columnHeaders || []).map(c => c.name);
      const g = name => { const i = cols.indexOf(name); return i >= 0 ? aRow[i] : 0; };
      const overall = {
        views: g('views') || 0,
        minutesWatched: g('estimatedMinutesWatched') || 0,
        avgViewDuration: g('averageViewDuration') || 0,
        avgViewPercentage: g('averageViewPercentage') || 0,
        subscribersGained: g('subscribersGained') || 0,
        likes: g('likes') || 0,
      };

      // 2. Analytics por vídeo (top 25 por views)
      const vParams = new URLSearchParams({
        ids: 'channel==MINE', startDate: fmtDate(start), endDate: fmtDate(today),
        metrics: 'views,averageViewPercentage,averageViewDuration,likes',
        dimensions: 'video', sort: '-views', maxResults: '25',
      });
      const vRes = await fetch(`https://youtubeanalytics.googleapis.com/v2/reports?${vParams}`, { headers: authH });
      const vData = await vRes.json();
      const vCols = (vData.columnHeaders || []).map(c => c.name);
      const perVideo = {};
      (vData.rows || []).forEach(r => {
        const id = r[vCols.indexOf('video')];
        perVideo[id] = {
          views: r[vCols.indexOf('views')] || 0,
          retention: Math.round(r[vCols.indexOf('averageViewPercentage')] || 0),
          avgDur: Math.round(r[vCols.indexOf('averageViewDuration')] || 0),
          likes: r[vCols.indexOf('likes')] || 0,
        };
      });

      // 3. Data API — títulos, tags e duração
      const ids = Object.keys(perVideo);
      let videos = [];
      if (ids.length) {
        const dRes = await fetch(
          `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${ids.join(',')}&key=${process.env.YOUTUBE_API_KEY}`
        );
        const dData = await dRes.json();
        videos = (dData.items || []).map(it => {
          const pv = perVideo[it.id] || {};
          const { durationStr } = parseDuration(it.contentDetails?.duration);
          return {
            id: it.id, title: it.snippet?.title || '', tags: it.snippet?.tags || [],
            publishedAt: it.snippet?.publishedAt || '', duration: durationStr,
            views: pv.views || 0, retention: pv.retention || 0, avgDur: pv.avgDur || 0, likes: pv.likes || 0,
          };
        });
      }

      // 4. Agregações
      const byRetention = [...videos].sort((a, b) => b.retention - a.retention);
      const topVideos = byRetention.slice(0, 5);
      const worstVideos = byRetention.slice(-5).reverse();
      const titleStructure = analyzeTitles(topVideos.map(v => v.title));

      const tagFreq = {};
      topVideos.forEach(v => v.tags.forEach(t => { const k = t.toLowerCase(); tagFreq[k] = (tagFreq[k] || 0) + 1; }));
      const topTags = Object.entries(tagFreq).sort((a, b) => b[1] - a[1]).slice(0, 15).map(x => x[0]);

      const dates = videos.map(v => v.publishedAt).filter(Boolean).map(d => new Date(d)).sort((a, b) => a - b);
      let postFreqDays = null;
      if (dates.length >= 2) {
        const span = (dates[dates.length - 1] - dates[0]) / 86400000;
        postFreqDays = Math.max(1, Math.round(span / (dates.length - 1)));
      }

      // 5. Monta o PROMPT pra IA
      const mm = Math.floor(overall.avgViewDuration / 60), ss = overall.avgViewDuration % 60;
      const lines = [];
      lines.push('Você é um especialista em crescimento de canais no YouTube. Analise os dados REAIS do meu canal abaixo e me dê melhorias concretas e acionáveis.');
      lines.push('');
      lines.push(`CANAL: ${row.channel_title}`);
      lines.push('PERÍODO: últimos 30 dias');
      lines.push('');
      lines.push('DESEMPENHO (dados reais do YouTube Analytics):');
      lines.push(`- Retenção média: ${Math.round(overall.avgViewPercentage)}%`);
      lines.push(`- Tempo médio de exibição: ${mm}m ${ss}s`);
      lines.push(`- Views no período: ${fmt(overall.views)} · Watch time: ${fmt(Math.round(overall.minutesWatched / 60))}h`);
      lines.push(`- Inscritos ganhos: ${fmt(overall.subscribersGained)} · Likes: ${fmt(overall.likes)}`);
      lines.push('');
      lines.push('TOP 5 VÍDEOS (por retenção):');
      topVideos.forEach((v, i) => lines.push(`${i + 1}. "${v.title}" — retenção ${v.retention}%, ${fmt(v.views)} views, ${v.duration}`));
      lines.push('');
      lines.push('PIORES 5 (menor retenção):');
      worstVideos.forEach((v, i) => lines.push(`${i + 1}. "${v.title}" — retenção ${v.retention}%, ${fmt(v.views)} views, ${v.duration}`));
      lines.push('');
      if (titleStructure) {
        lines.push('PADRÕES DOS TÍTULOS QUE MAIS RETÊM:');
        lines.push(`- Comprimento médio: ${titleStructure.avgLength} caracteres`);
        lines.push(`- ${titleStructure.pctNumber}% usam número · ${titleStructure.pctQuestion}% pergunta · ${titleStructure.pctEmoji}% emoji · ${titleStructure.pctBracket}% colchete/parêntese`);
        lines.push(`- Palavras mais frequentes: ${titleStructure.topWords.join(', ')}`);
        lines.push('');
      }
      if (topTags.length) lines.push(`TAGS/PALAVRAS-CHAVE MAIS USADAS: ${topTags.join(', ')}`);
      if (postFreqDays) lines.push(`FREQUÊNCIA: 1 vídeo a cada ${postFreqDays} dias`);
      lines.push('');
      lines.push('Com base nisso, entregue:');
      lines.push('1. 5 melhorias concretas de título + thumbnail');
      lines.push('2. O que está derrubando minha retenção e como corrigir');
      lines.push('3. 10 ideias de vídeo no meu nicho com alto potencial');
      lines.push('4. A estrutura de título ideal pro meu canal');
      const prompt = lines.join('\n');

      supabase.from('yt_channels').update({ last_analyzed_at: new Date().toISOString() })
        .eq('user_id', uid).eq('channel_id', channel_id).then(() => {}, () => {});

      return res.status(200).json({
        channel: { title: row.channel_title, thumb: row.channel_thumb },
        overall, topVideos, worstVideos, titleStructure, topTags, postFreqDays, prompt,
      });
    } catch (e) {
      console.error('[channel/report]', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'action inválida' });
};
