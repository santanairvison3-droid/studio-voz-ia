const { verifyToken } = require('./_lib/auth');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Token inválido ou expirado' });

  return res.status(200).json({ valid: true, user });
};
