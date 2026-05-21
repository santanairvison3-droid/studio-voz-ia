const { verifyToken } = require('./_lib/auth');
const { supabase } = require('./_lib/supabase');

// Limites diários por plano — altere aqui quando quiser
const PLAN_LIMITS = {
  free:    3,
  basico:  5,
  premium: 10
};

module.exports = async (req, res) => {
  // ── CORS ──
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
      const { action, code, plan, id } = req.body;
      if (action === 'create') {
        const { credits } = req.body;
        const insertData = { code, plan, credits: credits ?? 0 };
        const { data, error } = await supabase.from('vouchers').insert(insertData).select().single();
        if (error) return res.status(500).json({ error: error.message });
        return res.status(201).json(data);
      }
      if (action === 'revoke') {
        const { error } = await supabase.from('vouchers').delete().eq('id', id);
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ ok: true });
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
      .select('id, username, name, email, role, plan, status, lim_day, credits, daily_used, last_reset, created_at')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    const { action, id, username, name, email, pw, role, plan, status, lim_day } = req.body;

    if (action === 'create') {
      // Limite automático pelo plano — admin pode sobrescrever com lim_day manual
      const planLimit = PLAN_LIMITS[plan] ?? PLAN_LIMITS['basico'];
      const finalLimit = (lim_day !== undefined && lim_day !== null && lim_day !== '')
        ? parseInt(lim_day)
        : planLimit;

      const { data, error } = await supabase
        .from('users')
        .insert({
          username,
          name,
          email,
          pw,
          role:       role    || 'user',
          plan:       plan    || 'basico',
          status:     status  || 'ativo',
          lim_day:    finalLimit,
          credits:    finalLimit * 30,
          daily_used: 0,
          last_reset: new Date().toISOString().split('T')[0]
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

      // Se mudou o plano, atualiza lim_day automaticamente pelo plano
      if (plan !== undefined) {
        updates.plan    = plan;
        updates.lim_day = PLAN_LIMITS[plan] ?? 5;
        updates.credits = updates.lim_day * 30;
      }

      // Override manual de lim_day (sobrescreve o automático do plano se informado)
      if (lim_day !== undefined && lim_day !== null && lim_day !== '') {
        updates.lim_day = parseInt(lim_day);
        updates.credits = updates.lim_day * 30;
      }

      const { error } = await supabase.from('users').update(updates).eq('id', id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true });
    }
  }

  return res.status(405).json({ error: 'Método não permitido' });
};
