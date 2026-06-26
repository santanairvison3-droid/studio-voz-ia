const jwt = require('jsonwebtoken');

// Mesma divisão de chaves do generate-index.js: cada usuário sempre na mesma
// conta DarkPlanner (DP_API_KEY ou DP_API_KEY_2), de forma determinística.
function pickDpKey(uid) {
  const keys = [process.env.DP_API_KEY, process.env.DP_API_KEY_2].filter(Boolean);
  if (keys.length === 0) return null;
  if (keys.length === 1) return keys[0];
  const s = String(uid || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return keys[h % keys.length];
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer '))
    return res.status(401).json({ error: 'Token não fornecido' });

  let user;
  try {
    user = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }

  const apiKey = pickDpKey(user.sub || user.id);
  if (!apiKey) {
    return res.status(500).json({
      error: 'DP_API_KEY não configurada no Vercel',
      detail: 'Vá em Settings > Environment Variables e adicione DP_API_KEY (e, opcionalmente, DP_API_KEY_2)'
    });
  }

  // Tenta as duas URLs possíveis do DarkPlanner
  const URLS = [
    'https://app.darkplanner.com.br/api/v1/audio/voices',
    'https://app.darkplanner.com.br/api/v1/voices',
  ];

  for (const url of URLS) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'X-API-Key': apiKey,
          'Content-Type': 'application/json'
        }
      });

      const text = await response.text();

      if (!response.ok) {
        console.error(`[voices] ${url} → ${response.status}: ${text.substring(0, 200)}`);
        continue;
      }

      let data;
      try { data = JSON.parse(text); } catch (e) { continue; }

      // Aceita array direto ou {voices: [...]} ou {data: [...]}
      const voices = Array.isArray(data)
        ? data
        : (data.voices || data.data || data.items || data.result || null);

      if (!voices) {
        return res.status(200).json({ debug: true, raw: data, url_used: url });
      }

      console.log(`[voices] OK via ${url} — ${voices.length} vozes`);
      return res.status(200).json({ voices, total: voices.length });

    } catch (err) {
      console.error(`[voices] erro em ${url}:`, err.message);
      continue;
    }
  }

  return res.status(502).json({
    error: 'DarkPlanner API indisponível',
    detail: 'Nenhuma URL respondeu com sucesso. Verifique se a DP_API_KEY está correta.'
  });
};
