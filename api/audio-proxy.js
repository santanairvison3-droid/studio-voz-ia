const jwt = require('jsonwebtoken');

module.exports = async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : (req.query.token || '');
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });
  try { jwt.verify(token, process.env.JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Token inválido' }); }

  const audioUrl = req.query.url;
  if (!audioUrl) return res.status(400).json({ error: 'url obrigatória' });

  try {
    // Tenta primeiro sem auth (CDN público)
    let upstream = await fetch(decodeURIComponent(audioUrl));
    
    // Se falhou, tenta com X-API-Key
    if (!upstream.ok) {
      upstream = await fetch(decodeURIComponent(audioUrl), {
        headers: { 'X-API-Key': process.env.DP_API_KEY }
      });
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
