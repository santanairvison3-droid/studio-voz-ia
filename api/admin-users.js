const { verifyToken } = require('./_lib/auth');
const { supabase } = require('./_lib/supabase');

const HARD_LIMIT = 50; // limite máximo absoluto por dia — ninguém passa disso, nem admin

// Limites padrão por plano
const PLAN_LIMITS = {
  free:    3,
  basico:  5,
  premium: 10
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Não autorizado' });
  if (user.role !== 'admin') return res.status(403).json({ error: 'Acesso negado' });

  const resource = req.query.resource || 'users';

  // ── VOUCHERS ──
  if (resource === 'vouchers') {
    if (req.method === 'GET') {
      const { data, error } = await supabase.from('vouchers').select('*').order('created_at', { ascending: false });
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json(data);
    }
    if (req.method === 'POST') {
      const { action, code, plan, credits, extra_audios, id } = req.body;

      if (action === 'create') {
        // Valida extra_audios contra o hard limit
        const safeExtraAudios = extra_audios ? Math.min(parseInt(extra_audios) || 0, HARD_LIMIT) : 0;
        const safeCredits = credits ?? 0;

        const { data, error } = await supabase
          .from('vouchers')
          .insert({ code, plan, credits: safeCredits, extra_audios: safeExtraAudios })
          .select()
          .single();
        if (error) return res.status(500).json({ error: error.message });
        return res.status(201).json(data);
      }

      if (action === 'revoke') {
        const { error } = await supabase.from('vouchers').delete().eq('id', id);
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ ok: true });
      }

      // ── GIVE EXTRA AUDIOS (admin dá áudios avulsos a um usuário) ──
      if (action === 'give_audios') {
        const { user_id, amount } = req.body;
        if (!user_id || !amount) return res.status(400).json({ error: 'user_id e amount são obrigatórios.' });

        const qty = parseInt(amount);
        if (isNaN(qty) || qty < 1) return res.status(400).json({ error: 'Amount deve ser número positivo.' });

        // Busca limite atual do usuário
        const { data: userData, error: ue } = await supabase
          .from('users')
          .select('lim_day, extra_audios, username, name')
          .eq('id', user_id)
          .single();
        if (ue || !userData) return res.status(404).json({ error: 'Usuário não encontrado.' });

        const currentLim = userData.lim_day || 5;
        const currentExtra = userData.extra_audios || 0;
        // Nunca ultrapassa o HARD_LIMIT
        const newLim = Math.min(currentLim + qty, HARD_LIMIT);
        const actualAdded = newLim - currentLim;

        if (actualAdded === 0)
          return res.status(400).json({ error: `Usuário já está no limite máximo de ${HARD_LIMIT} áudios/dia.` });

        const { error: updateErr } = await supabase
          .from('users')
          .update({ lim_day: newLim, extra_audios: currentExtra + actualAdded })
          .eq('id', user_id);

        if (updateErr) return res.status(500).json({ error: updateErr.message });

        return res.status(200).json({
          ok: true,
          message: `+${actualAdded} áudio(s) liberado(s) para ${userData.name || userData.username}. Novo limite: ${newLim}/dia.`,
          new_lim_day: newLim,
          actual_added: actualAdded
        });
      }
    }
  }

  // ── LOGS ──
  if (resource === 'logs') {
    const { data, error } = await supabase
      .from('audio_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  // ── USERS ──
  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('users')
      .select('id, username, name, email, role, plan, status, lim_day, credits, daily_used, extra_audios, last_reset, created_at')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    const { action, id, username, name, email, pw, role, plan, status, lim_day } = req.body;

    if (action === 'create') {
      const planLimit = PLAN_LIMITS[plan] ?? PLAN_LIMITS['basico'];
      const rawLimit = (lim_day !== undefined && lim_day !== null && lim_day !== '')
        ? parseInt(lim_day)
        : planLimit;
      const finalLimit = Math.min(rawLimit, HARD_LIMIT); // nunca passa do hard limit

      const { data, error } = await supabase
        .from('users')
        .insert({
          username,
          name,
          email,
          pw,
          role:        role   || 'user',
          plan:        plan   || 'basico',
          status:      status || 'ativo',
          lim_day:     finalLimit,
          credits:     finalLimit * 30,
          extra_audios: 0,
          daily_used:  0,
          last_reset:  new Date().toISOString().split('T')[0]
        })
        .select()
        .single();

      if (error) return res.status(500).json({ error: error.message });
      return res.status(201).json(data);
    }

    if (action === 'update') {
      const updates = {};
      if (status !== undefined) updates.status = status;
      if (role   !== undefined) updates.role   = role;
      if (pw     !== undefined) updates.pw     = pw;

      if (plan !== undefined) {
        updates.plan    = plan;
        const planLim   = PLAN_LIMITS[plan] ?? 5;
        updates.lim_day = Math.min(planLim, HARD_LIMIT);
        updates.credits = updates.lim_day * 30;
        updates.extra_audios = 0; // reset extras ao trocar plano
      }

      if (lim_day !== undefined && lim_day !== null && lim_day !== '') {
        updates.lim_day = Math.min(parseInt(lim_day), HARD_LIMIT);
        updates.credits = updates.lim_day * 30;
      }

      const { error } = await supabase.from('users').update(updates).eq('id', id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true });
    }
  }

  return res.status(405).json({ error: 'Método não permitido' });
};
