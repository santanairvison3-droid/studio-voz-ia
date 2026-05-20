const jwt = require('jsonwebtoken');

module.exports = async (req, res) => {
  // Auth check
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }
  try {
    jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }

  const audioUrl = req.query.url;
  if (!audioUrl) return res.status(400).json({ error: 'url obrigatória' });

  try {
    // Busca o áudio do DarkPlanner com a chave de API
    const upstream = await fetch(decodeURIComponent(audioUrl), {
      headers: { 'X-API-Key': process.env.DP_API_KEY }
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `DarkPlanner retornou ${upstream.status}` });
    }

    const contentType = upstream.headers.get('content-type') || 'audio/mpeg';
    const contentLength = upstream.headers.get('content-length');

    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    // Stream o áudio direto para o browser
    const buffer = await upstream.arrayBuffer();
    res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar áudio: ' + err.message });
  }
};
