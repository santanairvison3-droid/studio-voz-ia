const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer '))
    return res.status(401).json({ error: 'Não autorizado' });

  let user;
  try { user = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Token inválido' }); }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
  const uid = user.sub || user.id;

  // ── GET: busca favoritas do banco ──────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('users')
        .select('favorites')
        .eq('id', uid)
        .single();

      if (error) throw error;
      return res.status(200).json({ favorites: data?.favorites || [] });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST: salva favoritas no banco ─────────────────────────────────────
  if (req.method === 'POST') {
    const { favorites } = req.body || {};

    if (!Array.isArray(favorites))
      return res.status(400).json({ error: 'favorites deve ser um array' });

    try {
      const { error } = await supabase
        .from('users')
        .update({ favorites: favorites.slice(0, 200) }) // máx 200 favoritas
        .eq('id', uid);

      if (error) throw error;
      return res.status(200).json({ ok: true, count: favorites.length });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Método não permitido' });
};
