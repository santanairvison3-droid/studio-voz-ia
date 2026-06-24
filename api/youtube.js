const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const HUNT_LIMIT = 2; // caçadas de nicho por conta por dia (protege a cota da API)

// VPH = views por hora desde a publicação. Sinal mais sensível de "hype" que views/dia.
function calcVPH(v) {
  const views = v.views || 0;
  const pub = v.publishedRaw ? new Date(v.publishedRaw) : null;
  const hoursSince = pub ? Math.max(1, (Date.now() - pub) / 3600000) : 2160; // ~90 dias
  return views / hoursSince;
}

// Detecta canal-referência em "hype" (padrão típico de canal automatizado/feito por IA):
// poucos inscritos + poucos vídeos + cada vídeo rende muito mais que a base de inscritos.
function hypeBonus(v) {
  const subs = Math.max(v.subscribers, 1);
  const chVideos = v.channelVideoCount || 0;
  const chViews = v.channelViews || 0;
  const chAvgViews = chVideos > 0 ? chViews / chVideos : 0;
  let hype = 0;
  if (chVideos > 0 && chVideos <= 30) hype += 8;        // canal novo / poucos vídeos
  else if (chVideos > 0 && chVideos <= 80) hype += 4;
  if (subs < 50000) hype += 4;                           // base pequena de inscritos
  if (chAvgViews > 0 && chAvgViews / subs >= 3) hype += 8; // cada vídeo estoura vs inscritos
  else if (chAvgViews > 0 && chAvgViews / subs >= 1) hype += 4;
  return Math.min(20, hype);
}

// Score viral calculado no servidor para ordenar os resultados
function viralScore(v) {
  const views = v.views || 0;
  const subs = Math.max(v.subscribers, 1);
  const pub = v.publishedRaw ? new Date(v.publishedRaw) : null;
  const daysSince = pub ? Math.max(1, Math.round((Date.now() - pub) / 86400000)) : 90;
  const ratio = views / subs;
  const vph = calcVPH(v);

  let score = 0;
  // Fator 1: Ratio views/inscritos (0-35pts) — canal furou a bolha
  score += ratio >= 20 ? 35 : ratio >= 10 ? 30 : ratio >= 5 ? 24 : ratio >= 2 ? 17 : ratio >= 1 ? 10 : 5;
  // Fator 2: VPH — views por hora (0-30pts) — hype em tempo real
  score += vph >= 5000 ? 30 : vph >= 1000 ? 25 : vph >= 200 ? 18 : vph >= 50 ? 11 : vph >= 10 ? 5 : 1;
  // Fator 3: Canal-referência / hype-IA (0-20pts) — poucos inscritos + poucos vídeos + média alta
  score += hypeBonus(v);
  // Fator 4: Frescor (0-10pts)
  score += daysSince <= 3 ? 10 : daysSince <= 7 ? 8 : daysSince <= 14 ? 6 : daysSince <= 30 ? 4 : daysSince <= 90 ? 2 : 1;
  // Fator 5: Engajamento likes/views (0-10pts) — conteúdo que o público aprova
  if (views > 0 && v.likes > 0) {
    const eng = v.likes / views;
    score += eng >= 0.1 ? 10 : eng >= 0.05 ? 7 : eng >= 0.02 ? 4 : eng >= 0.01 ? 2 : 0;
  }
  return Math.min(100, Math.round(score));
}

function parseDuration(isoStr) {
  const m = (isoStr || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return { durationStr: '', totalSec: 0, videoType: 'medium' };
  const h = parseInt(m[1]) || 0;
  const min = parseInt(m[2]) || 0;
  const s = parseInt(m[3]) || 0;
  const totalSec = h * 3600 + min * 60 + s;
  const durationStr = h
    ? `${h}:${String(min).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${min}:${String(s).padStart(2, '0')}`;
  // YouTube Shorts: até 180s (3 min) conforme política atual
  const videoType = totalSec <= 180 ? 'short' : totalSec >= 1200 ? 'long' : 'medium';
  return { durationStr, totalSec, videoType };
}

// Busca sugestões reais de palavras-chave do YouTube (autocomplete). Zero cota.
async function fetchSuggestions(query, hl, gl) {
  try {
    const r = await fetch(
      `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=${hl}&gl=${gl}&q=${encodeURIComponent(query)}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const raw = await r.text();
    const data = JSON.parse(raw);
    return (data[1] || []).filter(s => s && s.toLowerCase() !== query.toLowerCase());
  } catch {
    return [];
  }
}

// Converte um item de search.list + stats em objeto de vídeo padronizado
function mapVideoItem(item, videoMap, channelMap) {
  const vid = item.id?.videoId || item.id;
  if (!vid) return null;
  const snippet = item.snippet || {};
  const stats = videoMap[vid]?.statistics || {};
  const channelStats = channelMap[snippet.channelId]?.statistics || {};
  const { durationStr, totalSec, videoType } = parseDuration(videoMap[vid]?.contentDetails?.duration);
  const pub = snippet.publishedAt ? new Date(snippet.publishedAt).toLocaleDateString('pt-BR') : '';
  return {
    id: vid,
    title: snippet.title || '',
    channel: snippet.channelTitle || '',
    channelId: snippet.channelId || '',
    thumbnail: snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || '',
    views: parseInt(stats.viewCount) || 0,
    likes: parseInt(stats.likeCount) || 0,
    subscribers: parseInt(channelStats.subscriberCount) || 0,
    channelVideoCount: parseInt(channelStats.videoCount) || 0,
    channelViews: parseInt(channelStats.viewCount) || 0,
    duration: durationStr,
    totalSec, videoType,
    published: pub,
    publishedRaw: snippet.publishedAt || '',
  };
}

// ── BANCO DE MÍDIA (Pexels + Pixabay) ──────────────────────────
// Helpers do action=stock. Tudo aqui dentro do youtube.js de propósito:
// o Vercel Hobby só permite 12 funções em api/ e já estamos no teto,
// então NÃO criamos api/media.js — reaproveitamos este endpoint.

// Classifica orientação pela proporção (fallback quando o provedor não filtra)
function orientOf(w, h) {
  if (!w || !h) return 'all';
  const r = w / h;
  if (r >= 1.2) return 'horizontal';
  if (r <= 0.85) return 'vertical';
  return 'square';
}
function matchOrient(it, want) {
  if (!want || want === 'all') return true;
  return orientOf(it.width, it.height) === want;
}

// Pexels: imagens (v1/search) e vídeos (videos/search). Chave no header Authorization.
// Filtra orientação nativamente (landscape|portrait|square) — sem pós-filtro.
async function fetchPexels({ key, type, q, orient, page, perPage }) {
  const orientMap = { horizontal: 'landscape', vertical: 'portrait', square: 'square' };
  const params = new URLSearchParams({ query: q, per_page: String(perPage), page: String(page) });
  if (orientMap[orient]) params.set('orientation', orientMap[orient]);
  const base = type === 'video'
    ? 'https://api.pexels.com/videos/search'
    : 'https://api.pexels.com/v1/search';
  const r = await fetch(`${base}?${params}`, { headers: { Authorization: key } });
  if (!r.ok) return { items: [], hasMore: false, err: `Pexels ${r.status}` };
  const d = await r.json();
  let items;
  if (type === 'video') {
    items = (d.videos || []).map(v => {
      const files = (v.video_files || []).slice().sort((a, b) => (b.width || 0) - (a.width || 0));
      const best = files.find(f => f.quality === 'hd') || files[0] || {};
      return {
        id: 'px_' + v.id, source: 'pexels', type: 'video',
        thumb: v.image || '', previewUrl: v.image || '',
        downloadUrl: best.link || '',
        width: v.width || 0, height: v.height || 0,
        author: v.user?.name || '', pageUrl: v.url || '', duration: v.duration || 0,
      };
    });
  } else {
    items = (d.photos || []).map(p => ({
      id: 'px_' + p.id, source: 'pexels', type: 'image',
      thumb: p.src?.tiny || p.src?.small || '',
      previewUrl: p.src?.large || p.src?.medium || '',
      downloadUrl: p.src?.original || p.src?.large2x || '',
      width: p.width || 0, height: p.height || 0,
      author: p.photographer || '', pageUrl: p.url || '', duration: 0,
    }));
  }
  const total = d.total_results || 0;
  return { items, hasMore: page * perPage < total };
}

// Pixabay: imagens (/api/) e vídeos (/api/videos/). Chave na query (?key=).
// Imagens: só horizontal|vertical nativo (sem "square" → pós-filtro por proporção).
// Vídeos: sem param de orientação → pós-filtro por proporção quando pedido.
async function fetchPixabay({ key, type, q, orient, page, perPage }) {
  if (type === 'video') {
    const params = new URLSearchParams({ key, q, per_page: String(perPage), page: String(page) });
    const r = await fetch(`https://pixabay.com/api/videos/?${params}`);
    if (!r.ok) return { items: [], hasMore: false, err: `Pixabay ${r.status}` };
    const d = await r.json();
    let items = (d.hits || []).map(h => {
      const v = h.videos || {};
      const best = v.large?.url ? v.large : v.medium?.url ? v.medium : v.small || v.tiny || {};
      const dims = v.large || v.medium || v.small || v.tiny || {};
      const thumb = v.large?.thumbnail || v.medium?.thumbnail ||
        (h.picture_id ? `https://i.vimeocdn.com/video/${h.picture_id}_295x166.jpg` : '');
      return {
        id: 'pb_' + h.id, source: 'pixabay', type: 'video',
        thumb, previewUrl: thumb,
        downloadUrl: best.url || '',
        width: dims.width || 0, height: dims.height || 0,
        author: h.user || '', pageUrl: h.pageURL || '', duration: h.duration || 0,
      };
    });
    if (orient && orient !== 'all') items = items.filter(it => matchOrient(it, orient));
    return { items, hasMore: page * perPage < (d.totalHits || 0) };
  }
  const orientMap = { horizontal: 'horizontal', vertical: 'vertical' };
  const params = new URLSearchParams({ key, q, image_type: 'photo', per_page: String(perPage), page: String(page) });
  if (orientMap[orient]) params.set('orientation', orientMap[orient]);
  const r = await fetch(`https://pixabay.com/api/?${params}`);
  if (!r.ok) return { items: [], hasMore: false, err: `Pixabay ${r.status}` };
  const d = await r.json();
  let items = (d.hits || []).map(h => ({
    id: 'pb_' + h.id, source: 'pixabay', type: 'image',
    thumb: h.previewURL || h.webformatURL || '',
    previewUrl: h.webformatURL || h.largeImageURL || '',
    downloadUrl: h.fullHDURL || h.largeImageURL || h.webformatURL || '',
    width: h.imageWidth || 0, height: h.imageHeight || 0,
    author: h.user || '', pageUrl: h.pageURL || '', duration: 0,
  }));
  if (orient === 'square') items = items.filter(it => matchOrient(it, 'square'));
  return { items, hasMore: page * perPage < (d.totalHits || 0) };
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer '))
    return res.status(401).json({ error: 'Não autorizado' });

  let user;
  try { user = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Token inválido' }); }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'YOUTUBE_API_KEY não configurada no Vercel.' });

  const {
    query, order = 'viewCount', region = 'BR',
    date = '', min_subs = '', max_subs = '',
    video_type = '', lang = '', page = '',
    duration = '', video_definition = '',
    min_views = '', min_dur = '',
    action = '', channel_url = '', qty = '50', ord = 'date'
  } = req.query;

  // ── SUGESTÕES DE PALAVRAS-CHAVE (autocomplete real do YouTube) ──
  // Mostra o que as pessoas DIGITAM de verdade. Zero cota da Data API.
  if (action === 'suggest') {
    if (!query) return res.status(400).json({ error: 'query obrigatório' });
    const hl = lang || { BR: 'pt', US: 'en', PT: 'pt', ES: 'es', MX: 'es', FR: 'fr' }[region] || 'pt';
    const gl = region || 'BR';
    try {
      const r = await fetch(
        `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=${hl}&gl=${gl}&q=${encodeURIComponent(query)}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      const raw = await r.text();
      let data;
      try { data = JSON.parse(raw); } catch { data = [query, []]; }
      const suggestions = (data[1] || []).filter(s => s && s.toLowerCase() !== query.toLowerCase());
      return res.status(200).json({ query, suggestions });
    } catch (e) {
      console.error('[youtube/suggest]', e.message);
      return res.status(200).json({ query, suggestions: [] });
    }
  }

  // ── TEMAS EM ALTA (vídeos bombando na região AGORA) ──
  // Custa só 1 unidade de cota (vs. 100 da busca normal).
  if (action === 'trending') {
    try {
      const params = new URLSearchParams({
        part: 'snippet,statistics,contentDetails',
        chart: 'mostPopular',
        regionCode: region || 'BR',
        maxResults: '50',
        key: apiKey,
      });
      if (req.query.category) params.set('videoCategoryId', req.query.category);

      const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params}`);
      const d = await r.json();
      if (!r.ok) return res.status(500).json({ error: d.error?.message || 'Erro ao buscar tendências' });

      const items = d.items || [];
      // Busca inscritos dos canais para calcular o score viral
      const channelIds = [...new Set(items.map(i => i.snippet?.channelId).filter(Boolean))].join(',');
      const chRes = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelIds}&key=${apiKey}`);
      const chData = await chRes.json();
      const channelMap = {};
      (chData.items || []).forEach(c => { channelMap[c.id] = c; });

      const result = items.map(item => {
        const snippet = item.snippet || {};
        const stats = item.statistics || {};
        const channelStats = channelMap[snippet.channelId]?.statistics || {};
        const { durationStr, totalSec, videoType } = parseDuration(item.contentDetails?.duration);
        const pub = snippet.publishedAt ? new Date(snippet.publishedAt).toLocaleDateString('pt-BR') : '';
        return {
          id: item.id,
          title: snippet.title || '',
          channel: snippet.channelTitle || '',
          channelId: snippet.channelId || '',
          thumbnail: snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || '',
          views: parseInt(stats.viewCount) || 0,
          likes: parseInt(stats.likeCount) || 0,
          subscribers: parseInt(channelStats.subscriberCount) || 0,
          channelVideoCount: parseInt(channelStats.videoCount) || 0,
          channelViews: parseInt(channelStats.viewCount) || 0,
          duration: durationStr,
          totalSec, videoType,
          published: pub,
          publishedRaw: snippet.publishedAt || '',
        };
      });
      result.sort((a, b) => viralScore(b) - viralScore(a));
      return res.status(200).json({ items: result, nextPage: '' });
    } catch (e) {
      console.error('[youtube/trending]', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── CAÇAR NICHO (expansão semântica de palavra-chave) ──
  // Descobre variações REAIS do termo (autocomplete) e busca todas,
  // varrendo o nicho inteiro em vez de só o match literal do título.
  if (action === 'hunt') {
    if (!query) return res.status(400).json({ error: 'query obrigatório' });

    // Limite diário de caçadas por conta (protege a cota compartilhada da API)
    const huntLimit = user.lim_hunt || HUNT_LIMIT;
    let huntsToday = 0;
    try {
      const today = new Date().toISOString().split('T')[0];
      const { count } = await supabase
        .from('hunt_log')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.sub || user.id)
        .gte('created_at', `${today}T00:00:00`)
        .lte('created_at', `${today}T23:59:59`);
      huntsToday = count || 0;
    } catch (e) {}

    if (huntsToday >= huntLimit)
      return res.status(429).json({ error: `Limite diário de caçadas atingido (${huntLimit}/dia). Use a busca normal ou volte amanhã.` });

    try {
      const hl = lang || { BR: 'pt', US: 'en', PT: 'pt', ES: 'es', MX: 'es', FR: 'fr' }[region] || 'pt';
      const gl = region || 'BR';

      // 1. Descobre variações reais do nicho (grátis)
      const sugs = await fetchSuggestions(query, hl, gl);
      // Query original + até 4 variações mais buscadas
      const queries = [query, ...sugs.slice(0, 4)];

      // Filtro de data (mesma lógica da busca normal)
      let publishedAfter = '';
      if (date) {
        const now = new Date();
        const days = { today: 1, week: 7, month: 30, year: 365 }[date] || 0;
        if (days) { now.setTime(now.getTime() - days * 86400000); publishedAfter = now.toISOString(); }
      }
      let videoDuration = '';
      if (duration === 'short' || duration === 'medium' || duration === 'long') videoDuration = duration;
      else if (video_type === 'short') videoDuration = 'short';

      // 2. Busca cada variação em paralelo (1 página cada)
      const searches = await Promise.all(queries.map(q => {
        const p = new URLSearchParams({
          part: 'snippet', q, type: 'video', order: 'viewCount',
          maxResults: '25', key: apiKey,
          ...(region && { regionCode: region }),
          ...(lang && { relevanceLanguage: lang }),
          ...(publishedAfter && { publishedAfter }),
          ...(videoDuration && { videoDuration }),
        });
        return fetch(`https://www.googleapis.com/youtube/v3/search?${p}`).then(r => r.json()).catch(() => ({ items: [] }));
      }));

      // Registra a caçada (a cota já foi consumida pelas buscas acima)
      supabase.from('hunt_log').insert({ user_id: user.sub || user.id }).then(() => {}, () => {});

      // 3. Junta e deduplica por videoId
      const seen = new Set();
      const allItems = [];
      searches.forEach(d => (d.items || []).forEach(it => {
        const vid = it.id?.videoId;
        if (vid && !seen.has(vid)) { seen.add(vid); allItems.push(it); }
      }));
      if (!allItems.length) return res.status(200).json({ items: [], expanded: queries, nextPage: '' });

      // 4. Busca stats de vídeos e canais (em lotes de 50)
      const videoIds = allItems.map(i => i.id?.videoId).filter(Boolean);
      const channelIds = [...new Set(allItems.map(i => i.snippet?.channelId).filter(Boolean))];
      const videoMap = {}, channelMap = {};
      for (let i = 0; i < videoIds.length; i += 50) {
        const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id=${videoIds.slice(i, i + 50).join(',')}&key=${apiKey}`);
        const d = await r.json();
        (d.items || []).forEach(v => { videoMap[v.id] = v; });
      }
      for (let i = 0; i < channelIds.length; i += 50) {
        const r = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelIds.slice(i, i + 50).join(',')}&key=${apiKey}`);
        const d = await r.json();
        (d.items || []).forEach(c => { channelMap[c.id] = c; });
      }

      // 5. Monta, filtra e ordena por score viral
      const minSubsVal = parseInt(min_subs) || 0;
      const maxSubsVal = parseInt(max_subs) || 0;
      const minViewsVal = parseInt(min_views) || 0;
      const minDurSec = parseInt(min_dur) || 0;

      const result = allItems.map(it => mapVideoItem(it, videoMap, channelMap)).filter(v => {
        if (!v) return false;
        if (minSubsVal && v.subscribers < minSubsVal) return false;
        if (maxSubsVal && v.subscribers > maxSubsVal) return false;
        if (minViewsVal && v.views < minViewsVal) return false;
        if (minDurSec && v.totalSec < minDurSec) return false;
        if (video_type === 'short' && v.videoType !== 'short') return false;
        if (video_type === 'long' && v.videoType !== 'long') return false;
        if (video_type === 'video' && v.videoType === 'short') return false;
        return true;
      });
      result.sort((a, b) => viralScore(b) - viralScore(a));

      return res.status(200).json({ items: result, expanded: queries, nextPage: '' });
    } catch (e) {
      console.error('[youtube/hunt]', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── INSIGHTS DE CANAL ──────────────────────────────────────────
  if (action === 'channel') {
    if (!channel_url) return res.status(400).json({ error: 'channel_url obrigatório' });
    try {
      const handleMatch = channel_url.match(/@([\w.-]+)/);
      const idMatch = channel_url.match(/channel\/(UC[\w-]+)/);
      let channelId = '';

      if (handleMatch) {
        const r = await fetch(
          `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent('@' + handleMatch[1])}&type=channel&maxResults=1&key=${apiKey}`
        );
        const d = await r.json();
        channelId = d.items?.[0]?.snippet?.channelId || d.items?.[0]?.id?.channelId || '';
      } else if (idMatch) {
        channelId = idMatch[1];
      }

      if (!channelId) return res.status(404).json({ error: 'Canal não encontrado. Verifique a URL.' });

      const [chRes, searchRes] = await Promise.all([
        fetch(`https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${channelId}&key=${apiKey}`),
        fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&type=video&order=${ord}&maxResults=50&key=${apiKey}`)
      ]);
      const [chData, searchData] = await Promise.all([chRes.json(), searchRes.json()]);

      const chInfo = chData.items?.[0] || {};
      const chStats = chInfo.statistics || {};
      const chSnippet = chInfo.snippet || {};
      const items = searchData.items || [];
      if (!items.length) return res.status(200).json({ items: [], channel: {}, nextPage: '' });

      const videoIds = items.map(i => i.id?.videoId).filter(Boolean).join(',');
      const vRes = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id=${videoIds}&key=${apiKey}`
      );
      const vData = await vRes.json();
      const vMap = {};
      (vData.items || []).forEach(v => { vMap[v.id] = v; });

      const chSubscribers = parseInt(chStats.subscriberCount) || 0;
      const chVideoCount = parseInt(chStats.videoCount) || 0;
      const chTotalViews = parseInt(chStats.viewCount) || 0;

      const result = items.map(item => {
        const vid = item.id?.videoId;
        if (!vid) return null;
        const snippet = item.snippet || {};
        const stats = vMap[vid]?.statistics || {};
        const { durationStr, totalSec, videoType } = parseDuration(vMap[vid]?.contentDetails?.duration);
        const pub = snippet.publishedAt ? new Date(snippet.publishedAt).toLocaleDateString('pt-BR') : '';
        const v = {
          id: vid,
          title: snippet.title || '',
          channel: snippet.channelTitle || '',
          channelId: snippet.channelId || '',
          thumbnail: snippet.thumbnails?.medium?.url || '',
          views: parseInt(stats.viewCount) || 0,
          likes: parseInt(stats.likeCount) || 0,
          subscribers: chSubscribers,
          channelVideoCount: chVideoCount,
          channelViews: chTotalViews,
          duration: durationStr,
          totalSec, videoType,
          published: pub,
          publishedRaw: snippet.publishedAt || '',
        };
        return v;
      }).filter(Boolean);

      result.sort((a, b) => viralScore(b) - viralScore(a));

      return res.status(200).json({
        items: result,
        channel: {
          name: chSnippet.title || '',
          thumbnail: chSnippet.thumbnails?.medium?.url || '',
          subscribers: chSubscribers,
          totalViews: parseInt(chStats.viewCount) || 0,
          videoCount: parseInt(chStats.videoCount) || 0,
        },
        nextPage: searchData.nextPageToken || ''
      });
    } catch (e) {
      console.error('[youtube/channel]', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── BANCO DE MÍDIA: Pexels + Pixabay (imagens e vídeos) ────────
  // Busca:    action=stock&source=pexels,pixabay&type=image|video&q=&orientation=&page=
  // Download: action=stock&dl=1&url=<enc>&name=<arquivo>  (força download + resolve CORS)
  if (action === 'stock') {
    // — modo download (proxy de arquivo) —
    if (req.query.dl) {
      const fileUrl = req.query.url || '';
      // allowlist: só CDNs dos provedores, p/ não virar proxy aberto
      if (!/^https?:\/\/([\w-]+\.)*(pexels\.com|pixabay\.com)\//i.test(fileUrl))
        return res.status(400).json({ error: 'URL não permitida' });
      try {
        const up = await fetch(fileUrl);
        if (!up.ok) return res.status(502).json({ error: 'Falha ao baixar do provedor' });
        const buf = Buffer.from(await up.arrayBuffer());
        const safeName = (req.query.name || 'midia').replace(/[^\w.\-]/g, '_');
        res.setHeader('Content-Type', up.headers.get('content-type') || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
        res.setHeader('Content-Length', buf.length);
        return res.status(200).end(buf);
      } catch (e) {
        console.error('[stock/dl]', e.message);
        return res.status(500).json({ error: 'Erro ao baixar arquivo' });
      }
    }

    // — modo busca —
    const q = (query || '').trim();
    if (!q) return res.status(400).json({ error: 'query obrigatório' });
    const type = req.query.type === 'video' ? 'video' : 'image';
    const orient = ['horizontal', 'vertical', 'square'].includes(req.query.orientation)
      ? req.query.orientation : 'all';
    const pageNum = Math.max(1, parseInt(page) || 1);
    let sources = String(req.query.source || 'pexels,pixabay')
      .split(',').map(s => s.trim().toLowerCase())
      .filter(s => s === 'pexels' || s === 'pixabay');
    if (!sources.length) sources = ['pexels', 'pixabay'];

    const PEXELS_KEY = process.env.PEXELS_KEY;
    const PIXABAY_KEY = process.env.PIXABAY_KEY;
    const perPage = 24;
    const tasks = [];
    if (sources.includes('pexels')) {
      tasks.push(PEXELS_KEY
        ? fetchPexels({ key: PEXELS_KEY, type, q, orient, page: pageNum, perPage })
        : Promise.resolve({ items: [], hasMore: false, err: 'PEXELS_KEY não configurada no Vercel.' }));
    }
    if (sources.includes('pixabay')) {
      tasks.push(PIXABAY_KEY
        ? fetchPixabay({ key: PIXABAY_KEY, type, q, orient, page: pageNum, perPage })
        : Promise.resolve({ items: [], hasMore: false, err: 'PIXABAY_KEY não configurada no Vercel.' }));
    }

    try {
      const results = await Promise.all(tasks);
      // intercala os itens dos provedores (round-robin) p/ misturar as fontes
      const lists = results.map(r => r.items || []);
      const merged = [];
      for (let i = 0, more = true; more; i++) {
        more = false;
        for (const list of lists) if (i < list.length) { merged.push(list[i]); more = true; }
      }
      const errors = results.map(r => r.err).filter(Boolean);
      return res.status(200).json({
        items: merged,
        page: pageNum,
        hasMore: results.some(r => r.hasMore),
        total: merged.length,
        errors,
      });
    } catch (e) {
      console.error('[stock/search]', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── BUSCA DE VÍDEOS ────────────────────────────────────────────
  if (!query) return res.status(400).json({ error: 'query obrigatório' });

  try {
    // Filtro de data
    let publishedAfter = '';
    if (date) {
      const now = new Date();
      const days = { today: 1, week: 7, month: 30, year: 365 }[date] || 0;
      if (days) {
        now.setTime(now.getTime() - days * 86400000);
        publishedAfter = now.toISOString();
      }
    }

    // Busca inteligente: "relevância" vira "date" para descobrir virais recentes.
    // Sem filtro de data explícito, restringe automaticamente aos últimos 6 meses.
    const ytOrder = order === 'relevance' ? 'date' : order;
    if (!publishedAfter && order === 'relevance') {
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
      publishedAfter = sixMonthsAgo.toISOString();
    }

    // Tipo de busca: channel e playlist são passados direto para a API
    const ytType = video_type === 'channel' ? 'channel'
                 : video_type === 'playlist' ? 'playlist'
                 : 'video';

    // Duração: filtro explícito tem prioridade; Shorts força 'short' na API
    let videoDuration = '';
    if (duration === 'short' || duration === 'medium' || duration === 'long') {
      videoDuration = duration;
    } else if (video_type === 'short') {
      videoDuration = 'short';
    }

    // Características de vídeo
    let videoDefinition = '';
    if (video_definition === 'hd' || video_definition === '4k') videoDefinition = 'high';

    const searchParams = new URLSearchParams({
      part: 'snippet',
      q: query,
      type: ytType,
      order: ytOrder,
      maxResults: 50,
      key: apiKey,
      ...(region && { regionCode: region }),
      ...(lang && { relevanceLanguage: lang }),
      ...(publishedAfter && { publishedAfter }),
      ...(videoDuration && { videoDuration }),
      ...(videoDefinition && { videoDefinition }),
      ...(video_definition === 'live' && { eventType: 'live' }),
      ...(video_definition === 'subtitles' && { videoCaption: 'closedCaption' }),
      ...(video_definition === 'creativeCommons' && { videoLicense: 'creativeCommon' }),
      ...(video_definition === '3d' && { videoDimension: '3d' }),
      ...(page && { pageToken: page }),
    });

    const searchRes = await fetch(`https://www.googleapis.com/youtube/v3/search?${searchParams}`);
    const searchData = await searchRes.json();

    if (!searchRes.ok) {
      console.error('[youtube] search error:', JSON.stringify(searchData));
      return res.status(500).json({ error: searchData.error?.message || 'Erro na API do YouTube' });
    }

    const items = searchData.items || [];
    if (!items.length) return res.status(200).json({ items: [], nextPage: '' });

    // Busca stats de vídeos e canais em paralelo
    const videoIds = items.map(i => i.id?.videoId).filter(Boolean).join(',');
    const channelIds = [...new Set(items.map(i => i.snippet?.channelId).filter(Boolean))].join(',');

    const [videosRes, channelsRes] = await Promise.all([
      fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id=${videoIds}&key=${apiKey}`),
      fetch(`https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelIds}&key=${apiKey}`)
    ]);
    const [videosData, channelsData] = await Promise.all([videosRes.json(), channelsRes.json()]);

    const videoMap = {};
    (videosData.items || []).forEach(v => { videoMap[v.id] = v; });
    const channelMap = {};
    (channelsData.items || []).forEach(c => { channelMap[c.id] = c; });

    const minSubsVal = parseInt(min_subs) || 0;
    const maxSubsVal = parseInt(max_subs) || 0;
    const minViewsVal = parseInt(min_views) || 0;
    const minDurSec = parseInt(min_dur) || 0;

    const result = items.map(item => {
      const vid = item.id?.videoId;
      if (!vid) return null;
      const snippet = item.snippet || {};
      const stats = videoMap[vid]?.statistics || {};
      const channelStats = channelMap[snippet.channelId]?.statistics || {};
      const { durationStr, totalSec, videoType } = parseDuration(videoMap[vid]?.contentDetails?.duration);
      const pub = snippet.publishedAt
        ? new Date(snippet.publishedAt).toLocaleDateString('pt-BR') : '';

      return {
        id: vid,
        title: snippet.title || '',
        channel: snippet.channelTitle || '',
        channelId: snippet.channelId || '',
        thumbnail: snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || '',
        views: parseInt(stats.viewCount) || 0,
        likes: parseInt(stats.likeCount) || 0,
        subscribers: parseInt(channelStats.subscriberCount) || 0,
        channelVideoCount: parseInt(channelStats.videoCount) || 0,
        channelViews: parseInt(channelStats.viewCount) || 0,
        duration: durationStr,
        totalSec, videoType,
        published: pub,
        publishedRaw: snippet.publishedAt || '',
      };
    }).filter(v => {
      if (!v) return false;
      if (minSubsVal && v.subscribers < minSubsVal) return false;
      if (maxSubsVal && v.subscribers > maxSubsVal) return false;
      if (minViewsVal && v.views < minViewsVal) return false;
      if (minDurSec && v.totalSec < minDurSec) return false;
      // Tipo de vídeo: filtro pós-busca para garantir
      if (video_type === 'short' && v.videoType !== 'short') return false;
      if (video_type === 'long' && v.videoType !== 'long') return false;
      if (video_type === 'video' && v.videoType === 'short') return false;
      return true;
    });

    // Ordena por score viral: ratio views/inscritos × velocidade × canal pequeno × frescor
    result.sort((a, b) => viralScore(b) - viralScore(a));

    return res.status(200).json({
      items: result,
      nextPage: searchData.nextPageToken || '',
      total: searchData.pageInfo?.totalResults || 0
    });

  } catch (e) {
    console.error('[youtube]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
