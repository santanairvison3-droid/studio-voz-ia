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

  if (req.method !== 'GET')
    return res.status(405).json({ error: 'Método não permitido' });

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
    const uid = user.sub || user.id;

    const { data, error } = await supabase
      .from('vw_user_stats')
      .select('*')
      .eq('user_id', uid)
      .maybeSingle();

    if (error) throw error;

    // Se não tem dados ainda, retorna zeros
    if (!data) {
      return res.status(200).json({
        stats: {
          total_audios:    0,
          total_characters: 0,
          audios_last_30d: 0,
          audios_today:    0,
          top_voices:      [],
          last_7_days:     []
        }
      });
    }

    return res.status(200).json({ stats: data });

  } catch (e) {
    console.error('[stats]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
