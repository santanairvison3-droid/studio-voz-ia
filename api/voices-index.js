const { verifyToken } = require('./_lib/auth');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Não autorizado' });

  try {
    const response = await fetch('https://app.darkplanner.com.br/api/v1/voices', {
      headers: {
        'Authorization': `Bearer ${process.env.DP_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao buscar vozes', detail: err.message });
  }
};
