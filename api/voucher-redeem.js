const { verifyToken } = require('./_lib/auth');
const { supabase } = require('./_lib/supabase');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Não autorizado' });

  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Código do voucher obrigatório' });

  // Buscar voucher válido
  const { data: voucher, error } = await supabase
    .from('vouchers')
    .select('*')
    .eq('code', code.toUpperCase())
    .eq('used', false)
    .single();

  if (error || !voucher) {
    return res.status(404).json({ error: 'Voucher inválido ou já utilizado' });
  }

  // Marcar voucher como usado
  await supabase.from('vouchers').update({
    used:    true,
    used_by: user.sub
  }).eq('id', voucher.id);

  // Atualizar plano do usuário (se a coluna plan existir)
  await supabase.from('users').update({ plan: voucher.plan }).eq('id', user.sub);

  return res.status(200).json({
    ok:      true,
    message: `Plano ${voucher.plan} ativado com sucesso!`,
    plan:    voucher.plan
  });
};
