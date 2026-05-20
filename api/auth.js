const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer '))
    return res.status(401).json({ error: 'Token não fornecido' });

  let decoded;
  try {
    decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }

  // Verifica validade de plano trial30
  if (decoded.valid_until && new Date(decoded.valid_until) < new Date()) {
    return res.status(401).json({ error: 'Seu acesso de 30 dias expirou. Renove seu plano.' });
  }

  // Tenta Supabase (opcional)
  let audiosHoje = 0, audiosEsseMes = 0, totalAudios = 0;
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
    const today = new Date().toISOString().split('T')[0];
    const uid = decoded.sub || decoded.id;

    const [{ count: ah }, { count: am }, { count: ta }] = await Promise.all([
      // Hoje
      supabase.from('audio_log').select('id', { count: 'exact', head: true })
        .eq('user_id', uid)
        .gte('created_at', `${today}T00:00:00`)
        .lte('created_at', `${today}T23:59:59`),
      // Este mês
      supabase.from('audio_log').select('id', { count: 'exact', head: true })
        .eq('user_id', uid)
        .gte('created_at', `${today.substring(0,7)}-01T00:00:00`),
      // Total
      supabase.from('audio_log').select('id', { count: 'exact', head: true })
        .eq('user_id', uid)
    ]);
    audiosHoje = ah || 0;
    audiosEsseMes = am || 0;
    totalAudios = ta || 0;
  } catch (e) {
    console.warn('[auth] Supabase indisponível:', e.message);
  }

  const limDay = decoded.lim_day ?? 5;
  const monthlyLimit = decoded.monthly_limit ?? null;

  return res.status(200).json({
    valid: true,
    user: {
      ...decoded,
      plan: decoded.plan || 'free',
      valid_until: decoded.valid_until || null,
      monthly_limit: monthlyLimit,
      daily: { audios: audiosHoje },
      monthly: { audios: audiosEsseMes },
      lim_day: limDay,
      total_audios: totalAudios,
      credits: Math.max(0, limDay - audiosHoje)
    }
  });
};
