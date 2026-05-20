const { verifyToken } = require('./_lib/auth');
const { supabase } = require('./_lib/supabase');

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
        const { data, error } = await supabase.from('vouchers').insert({ code, plan }).select().single();
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
      .select('id, username, name, email, role, plan, status, created_at')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    const { action, id, username, name, email, pw, role, plan, status } = req.body;

    if (action === 'create') {
      const { data, error } = await supabase
        .from('users')
        .insert({
          username,
          name,
          email,
          pw,
          role: role || 'user',
          plan: plan || 'basico',
          status: status || 'ativo'
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
      if (plan   !== undefined) updates.plan   = plan;
      if (pw     !== undefined) updates.pw     = pw;
      const { error } = await supabase.from('users').update(updates).eq('id', id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true });
    }
  }

  return res.status(405).json({ error: 'Método não permitido' });
};
