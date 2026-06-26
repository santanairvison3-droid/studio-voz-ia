const jwt = require('jsonwebtoken');

// Chaves DarkPlanner do usuário (com failover) — usado só no fallback X-API-Key
// (o normal é o CDN público). Com failover o áudio pode estar em qualquer conta.
function dpKeysFor(uid) {
  const keys = [process.env.DP_API_KEY, process.env.DP_API_KEY_2].filter(Boolean);
  if (keys.length <= 1) return keys;
  const s = String(uid || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const primary = h % keys.length;
  return [keys[primary], ...keys.filter((_, i) => i !== primary)];
}

module.exports = async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : (req.query.token || '');
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });
  let user;
  try { user = jwt.verify(token, process.env.JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Token inválido' }); }

  const audioUrl = req.query.url;
  if (!audioUrl) return res.status(400).json({ error: 'url obrigatória' });

  try {
    // Tenta primeiro sem auth (CDN público)
    let upstream = await fetch(decodeURIComponent(audioUrl));
    
    // Se falhou, tenta com X-API-Key — percorre as contas do usuário (failover)
    if (!upstream.ok) {
      for (const dpKey of dpKeysFor(user.sub || user.id)) {
        upstream = await fetch(decodeURIComponent(audioUrl), {
          headers: { 'X-API-Key': dpKey }
        });
        if (upstream.ok) break;
      }
    }

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `Falhou: HTTP ${upstream.status}` });
    }

    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const cl = upstream.headers.get('content-length');
    if (cl) res.setHeader('Content-Length', cl);

    const buffer = await upstream.arrayBuffer();
    res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).json({ error: 'Erro: ' + err.message });
  }
};
