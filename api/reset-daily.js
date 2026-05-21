/**
 * /api/reset-daily.js
 *
 * Roda automaticamente todo dia à meia-noite (horário de Brasília)
 * via Vercel Cron Jobs — configurado em vercel.json
 *
 * Também pode ser chamado manualmente pelo admin:
 *   GET /api/reset-daily?secret=SEU_CRON_SECRET
 */

const { createClient } = require('@supabase/supabase-js');

// Limite padrão por plano
const PLAN_LIMITS = { free: 3, basico: 5, premium: 10 };
const HARD_LIMIT  = 50;

function getTodayBR() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

module.exports = async (req, res) => {
  // ── Segurança: apenas Vercel Cron (header Authorization) ou admin com secret ──
  const cronSecret = process.env.CRON_SECRET;

  const authHeader = req.headers.authorization;
  const querySecret = req.query.secret;

  const isCronCall   = authHeader === `Bearer ${cronSecret}`;
  const isManualCall = cronSecret && querySecret === cronSecret;

  if (!isCronCall && !isManualCall) {
    return res.status(401).json({ error: 'Não autorizado' });
  }

  const today = getTodayBR();

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // ── Busca todos os usuários que NÃO foram resetados hoje ──
    const { data: usersToReset, error } = await supabase
      .from('users')
      .select('id, plan, lim_day, daily_used, last_reset')
      .neq('last_reset', today);  // inclui null e datas anteriores

    if (error) {
      console.error('[reset-daily] Erro ao buscar usuários:', error.message);
      return res.status(500).json({ error: 'Erro ao buscar usuários', detail: error.message });
    }

    if (!usersToReset || usersToReset.length === 0) {
      console.log(`[reset-daily] Nenhum usuário para resetar em ${today}`);
      return res.status(200).json({ reset: 0, date: today });
    }

    console.log(`[reset-daily] Resetando ${usersToReset.length} usuário(s) para ${today}`);

    // ── Reseta em lotes de 50 para não sobrecarregar o banco ──
    let totalReset = 0;
    const BATCH = 50;

    for (let i = 0; i < usersToReset.length; i += BATCH) {
      const batch = usersToReset.slice(i, i + BATCH);

      // Monta updates individuais respeitando o lim_day do plano de cada um
      const updates = batch.map(u => {
        const planLim  = PLAN_LIMITS[u.plan] ?? 5;
        const newLimit = Math.min(planLim, HARD_LIMIT);
        return supabase
          .from('users')
          .update({ daily_used: 0, last_reset: today, lim_day: newLimit })
          .eq('id', u.id);
      });

      // Executa o lote em paralelo
      const results = await Promise.allSettled(updates);
      const failed  = results.filter(r => r.status === 'rejected');
      if (failed.length > 0) {
        console.warn(`[reset-daily] ${failed.length} falha(s) no lote ${i / BATCH + 1}`);
      }
      totalReset += batch.length - failed.length;
    }

    console.log(`[reset-daily] ✓ ${totalReset} usuário(s) resetados`);
    return res.status(200).json({
      success: true,
      reset: totalReset,
      date: today
    });

  } catch (e) {
    console.error('[reset-daily] EXCEPTION:', e.message);
    return res.status(500).json({ error: 'Erro interno', detail: e.message });
  }
};
