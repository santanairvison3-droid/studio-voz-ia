const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

// ── Helpers ────────────────────────────────────────────────────────────────
// Usa timezone do Brasil (America/Sao_Paulo) para evitar reset no horário errado
function getTodayBR() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

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

    // ── Data no horário do Brasil (UTC-3) ──────────────────────────────────
    const today = getTodayBR();
    const uid = decoded.sub || decoded.id;

    // ── Busca dados frescos do banco (fonte de verdade) ────────────────────
    const { data: userData, error: userErr } = await supabase
      .from('users')
      .select('daily_used, last_reset, lim_day, credits, plan')
      .eq('id', uid)
      .single();

    if (!userErr && userData) {
      // lim_day do banco tem precedência sobre o JWT (admin pode ter alterado)
      if (userData.lim_day != null) limDay = userData.lim_day;

      const lastReset = userData.last_reset
        ? String(userData.last_reset).split('T')[0]
        : null;

      if (lastReset !== today) {
        // ── RESET DIÁRIO: novo dia detectado ──────────────────────────────
        // FIX: Não sobrescreve lim_day customizado — preserva valor definido pelo admin.
        // Usa limite do plano apenas como fallback se não houver lim_day no banco.
        const PLAN_LIMITS = { free: 3, basico: 5, premium: 10 };
        const planLim = PLAN_LIMITS[userData.plan] ?? 5;
        if (userData.lim_day == null) {
          limDay = Math.min(planLim, 50);
        }
        // limDay já definido acima com o valor do banco quando userData.lim_day != null

        await supabase
          .from('users')
          .update({ daily_used: 0, last_reset: today })  // NÃO sobrescreve lim_day
          .eq('id', uid);

        audiosHoje = 0; // reset confirmado
        console.log(`[auth] Reset diário aplicado para uid=${uid}, limDay mantido=${limDay}`);
      } else {
        audiosHoje = userData.daily_used || 0;
      }
    }

    // ── Contagem via audio_log (mensal/total) ──────────────────────────────
    try {
      const monthStart = `${today.substring(0, 7)}-01T00:00:00`;
      const [{ count: am }, { count: ta }] = await Promise.all([
        supabase.from('audio_log').select('id', { count: 'exact', head: true })
          .eq('user_id', uid)
          .gte('created_at', monthStart),
        supabase.from('audio_log').select('id', { count: 'exact', head: true })
          .eq('user_id', uid)
      ]);
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
      daily_used:    audiosHoje,
      daily:         { audios: audiosHoje },
      monthly:       { audios: audiosEsseMes },
      total_audios:  totalAudios,
      credits:       creditsRestantes
    }
  });
};
