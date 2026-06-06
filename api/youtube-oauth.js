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
  // Aceita chave em hex (64 chars) ou texto; normaliza para 32 bytes
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

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri)
    return res.status(500).json({ error: 'OAuth não configurado no servidor.' });

  const { action = '' } = req.query;

  // ── INÍCIO DO LOGIN: gera a URL de consentimento do Google ──
  if (action === 'login') {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer '))
      return res.status(401).json({ error: 'Não autorizado' });
    let user;
    try { user = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET); }
    catch { return res.status(401).json({ error: 'Token inválido' }); }

    // state assinado: identifica o usuário no callback (expira em 10min)
    const state = jwt.sign({ uid: user.sub || user.id }, process.env.JWT_SECRET, { expiresIn: '10m' });

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return res.status(200).json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
  }

  // ── CALLBACK: troca código por tokens e salva o canal ──
  if (action === 'callback') {
    const { code, state, error: oauthErr } = req.query;
    const back = (msg) => res.redirect(`/dashboard.html#canais${msg ? '=' + encodeURIComponent(msg) : ''}`);

    if (oauthErr) return back('cancelado');
    if (!code || !state) return back('erro');

    let uid;
    try { uid = jwt.verify(state, process.env.JWT_SECRET).uid; }
    catch { return back('expirado'); }

    try {
      // 1. Troca code por tokens
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      const tokens = await tokenRes.json();
      if (!tokens.access_token) {
        console.error('[oauth/callback] sem access_token', JSON.stringify(tokens));
        return back('erro_token');
      }
      // refresh_token só vem com prompt=consent; é o que precisamos guardar
      if (!tokens.refresh_token) return back('sem_refresh');

      // 2. Identifica o canal autorizado
      const chRes = await fetch(
        'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
        { headers: { Authorization: `Bearer ${tokens.access_token}` } }
      );
      const chData = await chRes.json();
      const ch = chData.items?.[0];
      if (!ch) return back('sem_canal');

      // 3. Valida teto de 5 canais (ignora se for reconexão do mesmo)
      const { data: existing } = await supabase
        .from('yt_channels')
        .select('channel_id')
        .eq('user_id', uid);
      const already = (existing || []).some(c => c.channel_id === ch.id);
      if (!already && (existing || []).length >= MAX_CHANNELS)
        return back('limite_canais');

      // 4. Salva (upsert) com refresh_token criptografado
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

  return res.status(400).json({ error: 'action inválida' });
};
