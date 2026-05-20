const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const { username, pw } = req.body;
  if (!username || !pw)
    return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });

  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('username', username)
    .eq('pw', pw)
    .eq('status', 'ativo')
    .single();

  if (error || !user)
    return res.status(401).json({ error: 'Usuário ou senha incorretos' });

  const payload = {
    sub:      user.id,
    username: user.username,
    name:     user.name     || user.username,
    email:    user.email    || '',
    role:     user.role     || 'user',
    plan:     user.plan     || 'basico',
    status:   user.status   || 'ativo'
  };

  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });
  return res.status(200).json({ token, user: payload });
};
