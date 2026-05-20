/**
 * POST /api/generate-access-code
 * Gera códigos de acesso de 30 dias (apenas ADMIN)
 * Body: { quantity: 1-50, monthly_limit: 5, label: "campanha X" }
 */
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

function randCode(prefix = 'ACC30') {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}-${code}`;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  // Verifica token ADMIN
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer '))
    return res.status(401).json({ error: 'Não autorizado' });

  let user;
  try { user = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Token inválido' }); }

  if (user.role !== 'admin')
    return res.status(403).json({ error: 'Apenas administradores podem gerar códigos.' });

  const { quantity = 1, monthly_limit = 5, label = '' } = req.body || {};

  if (quantity < 1 || quantity > 50)
    return res.status(400).json({ error: 'Quantidade deve ser entre 1 e 50.' });

  // Gera os códigos
  const codes = [];
  for (let i = 0; i < quantity; i++) {
    codes.push({
      code: randCode('ACC30'),
      monthly_limit: parseInt(monthly_limit) || 5,
      label: label || 'Acesso 30 dias',
      used: false,
      created_at: new Date().toISOString(),
      created_by: user.sub || user.id
    });
  }

  // Salva no Supabase se disponível
  let saved = false;
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
    const { error } = await supabase.from('access_codes').insert(codes);
    if (!error) saved = true;
  } catch (e) {
    console.warn('[gen-code] Supabase indisponível:', e.message);
  }

  return res.status(200).json({
    ok: true,
    saved_to_db: saved,
    quantity: codes.length,
    monthly_limit,
    codes: codes.map(c => c.code),
    message: saved
      ? `${codes.length} código(s) gerado(s) e salvos no banco.`
      : `${codes.length} código(s) gerado(s). ⚠️ Supabase indisponível — salve os códigos agora!`
  });
};
