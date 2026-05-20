const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer '))
    return res.status(401).json({ error: 'Token não fornecido' });

  let decoded;
  try {
    decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }

  // Contar áudios gerados hoje
  const today = new Date().toISOString().split('T')[0];
  const { count: audiosHoje } = await supabase
    .from('audio_log')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', decoded.sub || decoded.id)
    .gte('created_at', `${today}T00:00:00`)
    .lte('created_at', `${today}T23:59:59`);

  // Total geral
  const { count: totalAudios } = await supabase
    .from('audio_log')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', decoded.sub || decoded.id);

  return res.status(200).json({
    valid: true,
    user: {
      ...decoded,
      daily:        { audios: audiosHoje || 0 },
      lim_day:      5,
      total_audios: totalAudios || 0,
      credits:      Math.max(0, 5 - (audiosHoje || 0))
    }
  });
};
