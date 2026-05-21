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

  let audiosHoje = 0, audiosEsseMes = 0, totalAudios = 0;
  let limDay = decoded.lim_day ?? 5;

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
    const today = new Date().toISOString().split('T')[0];
    const uid = decoded.sub || decoded.id;

    // ── Busca dados do usuário na tabela users ──────────────────────────────
    // O generate-index incrementa users.daily_used (não escreve em audio_log),
    // por isso lemos daily_used aqui como fonte primária de verdade.
    const { data: userData, error: userErr } = await supabase
      .from('users')
      .select('daily_used, last_reset, lim_day, credits')
      .eq('id', uid)
      .single();

    if (!userErr && userData) {
      // daily_used só vale para hoje — se last_reset for de outro dia, está zerado
      const isTodayReset = userData.last_reset === today;
      const userDailyUsed = isTodayReset ? (userData.daily_used || 0) : 0;

      // lim_day do banco tem precedência sobre o JWT (admin pode ter alterado)
      if (userData.lim_day != null) limDay = userData.lim_day;

      // ── RESET AUTOMÁTICO: se last_reset não é hoje, zera no banco ──────────
      // Garante que generate-index também verá daily_used = 0 (novo dia)
      if (!isTodayReset) {
        await supabase
          .from('users')
          .update({ daily_used: 0, last_reset: today })
          .eq('id', uid);
      }

      audiosHoje = userDailyUsed;
    }

    // ── Contagem via audio_log (fallback / complemento) ────────────────────
    // Se o backend registrar em audio_log, usamos o maior entre os dois.
    try {
      const [{ count: ah }, { count: am }, { count: ta }] = await Promise.all([
        supabase.from('audio_log').select('id', { count: 'exact', head: true })
          .eq('user_id', uid)
          .gte('created_at', `${today}T00:00:00`)
          .lte('created_at', `${today}T23:59:59`),
        supabase.from('audio_log').select('id', { count: 'exact', head: true })
          .eq('user_id', uid)
          .gte('created_at', `${today.substring(0,7)}-01T00:00:00`),
        supabase.from('audio_log').select('id', { count: 'exact', head: true })
          .eq('user_id', uid)
      ]);
      // Usa o maior entre daily_used e contagem do log
      audiosHoje    = Math.max(audiosHoje, ah || 0);
      audiosEsseMes = am || 0;
      totalAudios   = ta || 0;
    } catch (e) {
      console.warn('[auth] audio_log query falhou:', e.message);
    }

  } catch (e) {
    console.warn('[auth] Supabase indisponível:', e.message);
  }

  const monthlyLimit = decoded.monthly_limit ?? null;
  const creditsRestantes = Math.max(0, limDay - audiosHoje);

  return res.status(200).json({
    valid: true,
    user: {
      ...decoded,
      plan:          decoded.plan || 'free',
      valid_until:   decoded.valid_until || null,
      monthly_limit: monthlyLimit,
      lim_day:       limDay,
      // fonte primária: daily_used (campo plano do Supabase)
      daily_used:    audiosHoje,
      // mantém o objeto aninhado para compatibilidade
      daily:         { audios: audiosHoje },
      monthly:       { audios: audiosEsseMes },
      total_audios:  totalAudios,
      credits:       creditsRestantes
    }
  });
};
