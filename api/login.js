const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// 🎁 Servidor de licenças do DarkBlue (outro projeto Supabase — o das chaves DBLU-).
// A ação "cortesia" é PÚBLICA de propósito: ela mesma se protege (só até 30/08,
// uma chave por e-mail). Assim o token de admin NUNCA precisa vir parar aqui.
const LICENCA_URL = 'https://emvgejbbusrbawohyfeu.supabase.co/functions/v1/licenca';
const LICENCA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVtdmdlamJidXNyYmF3b2h5ZmV1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwNTg3NzIsImV4cCI6MjA5MjYzNDc3Mn0.m9z64aEdOP4LF3GhTlel4vzRp-NFkL1xDOOREC8oFVg';

function tokenDe(user) {
  const payload = {
    sub:      user.id,
    username: user.username,
    name:     user.name     || user.username,
    email:    user.email    || '',
    role:     user.role     || 'user',
    plan:     user.plan     || 'basico',
    status:   user.status   || 'ativo'
  };
  return { token: jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' }), payload };
}

// pede a chave de cortesia. Nunca derruba o cadastro: se falhar, a conta é criada
// do mesmo jeito e a pessoa pede a chave depois.
async function chaveDeCortesia(email, nome) {
  try {
    const r = await fetch(LICENCA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + LICENCA_ANON },
      body: JSON.stringify({ acao: 'cortesia', email, nome })
    });
    const d = await r.json();
    return d.ok ? { chave: d.chave, expira_em: d.expira_em } : null;
  } catch {
    return null;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const { action, username, pw, name, email } = req.body || {};

  // ─────────────────────────── CRIAR CONTA ───────────────────────────
  // Cadastro aberto (09/08/2026). A conta nasce no plano GRÁTIS, SEM voz
  // (lim_day = 0 — a voz é só da turma, cadastrada à mão pelo dono), e já sai
  // com a chave do robô válida até 30/08.
  if (action === 'signup') {
    const user = String(username || '').trim().toLowerCase();
    const mail = String(email || '').trim().toLowerCase();
    if (!user || !pw || !mail)
      return res.status(400).json({ error: 'Preencha usuário, e-mail e senha.' });
    if (user.length < 3)
      return res.status(400).json({ error: 'O usuário precisa ter pelo menos 3 letras.' });
    if (!mail.includes('@') || !mail.includes('.'))
      return res.status(400).json({ error: 'Esse e-mail não parece válido.' });

    // já existe? (usuário OU e-mail — evita duas contas da mesma pessoa)
    const { data: existe } = await supabase
      .from('users').select('username, email')
      .or(`username.eq.${user},email.eq.${mail}`).limit(1);
    if (existe && existe.length) {
      const msg = existe[0].username === user
        ? 'Esse nome de usuário já está em uso. Escolha outro.'
        : 'Já existe uma conta com esse e-mail. Entre com ela.';
      return res.status(409).json({ error: msg });
    }

    const { data: novo, error } = await supabase
      .from('users')
      .insert({
        username: user,
        name: String(name || '').trim() || user,
        email: mail,
        pw,                       // já chega em SHA-256 (o site faz o hash antes de enviar)
        role: 'user',
        plan: 'gratis',           // plano novo: ferramentas com limite, SEM voz
        status: 'ativo',
        lim_day: 0,               // zero áudios: a voz não entra no comercial
        credits: 0,
        extra_audios: 0,
        daily_used: 0,
        last_reset: new Date().toISOString().split('T')[0]
      })
      .select().single();

    if (error) return res.status(500).json({ error: 'Não consegui criar a conta: ' + error.message });

    const { token, payload } = tokenDe(novo);
    const cortesia = await chaveDeCortesia(mail, novo.name);
    return res.status(201).json({ token, user: payload, cortesia });
  }

  // ─────────────────────────── ENTRAR ───────────────────────────
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

  const { token, payload } = tokenDe(user);
  return res.status(200).json({ token, user: payload });
};
