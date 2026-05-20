const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer '))
    return res.status(401).json({ error: 'Não autorizado' });

  let user;
  try { user = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Token inválido' }); }

  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Código obrigatório' });

  const upperCode = code.toUpperCase().trim();

  // ── Supabase (opcional) ──
  let supabase = null;
  try {
    const { createClient: cc } = require('@supabase/supabase-js');
    supabase = cc(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  } catch(e) {}

  // ── Vouchers hardcoded de créditos ──
  const STATIC_VOUCHERS = {
    'BETA2025':    { credits: 300, type: 'credits' },
    'PREMIUM500':  { credits: 500, type: 'credits' },
    'VIP1000':     { credits: 1000, type: 'credits' },
  };

  // ── Código de acesso 30 dias (formato: ACC30-XXXXXX) ──
  // Gerado via admin — salvo no Supabase na tabela 'access_codes'
  // Formato: ACC30-XXXXXX ou qualquer código que começa com ACC
  const isAccess30 = upperCode.startsWith('ACC') || upperCode.startsWith('TRIAL') || upperCode.startsWith('FREE');

  if (isAccess30) {
    if (!supabase) {
      return res.status(500).json({ error: 'Sistema de banco de dados não configurado.' });
    }
    // Busca código na tabela access_codes
    const { data: accCode, error: accErr } = await supabase
      .from('access_codes')
      .select('*')
      .eq('code', upperCode)
      .eq('used', false)
      .single();

    if (accErr || !accCode) {
      return res.status(404).json({ error: 'Código inválido ou já utilizado.' });
    }

    // Verifica se expirou
    if (accCode.expires_at && new Date(accCode.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Este código expirou.' });
    }

    // Calcula validade: 30 dias a partir de hoje
    const validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + 30);

    // Marca como usado
    await supabase.from('access_codes').update({
      used: true,
      used_by: user.sub || user.id,
      used_at: new Date().toISOString()
    }).eq('id', accCode.id);

    // Atualiza usuário no Supabase com plano e validade
    if (supabase) {
      await supabase.from('users').update({
        plan: 'trial30',
        valid_until: validUntil.toISOString(),
        monthly_limit: accCode.monthly_limit || 5
      }).eq('id', user.sub || user.id).catch(() => {});
    }

    // Gera novo token JWT com o plano atualizado
    const payload = {
      ...user,
      plan: 'trial30',
      valid_until: validUntil.toISOString(),
      lim_day: 5,
      monthly_limit: accCode.monthly_limit || 5
    };
    delete payload.iat;
    delete payload.exp;
    const newToken = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '35d' });

    return res.status(200).json({
      ok: true,
      message: `✅ Acesso de 30 dias ativado! Válido até ${validUntil.toLocaleDateString('pt-BR')}. Você tem ${accCode.monthly_limit||5} áudios por mês.`,
      plan: 'trial30',
      valid_until: validUntil.toISOString(),
      new_token: newToken
    });
  }

  // ── Vouchers de créditos estáticos ──
  if (STATIC_VOUCHERS[upperCode]) {
    const v = STATIC_VOUCHERS[upperCode];
    // Verifica se já usou (via Supabase se disponível)
    if (supabase) {
      const { data: usedVoucher } = await supabase
        .from('used_vouchers')
        .select('id')
        .eq('code', upperCode)
        .eq('user_id', user.sub || user.id)
        .single();
      if (usedVoucher) {
        return res.status(400).json({ error: 'Você já usou este voucher.' });
      }
      await supabase.from('used_vouchers').insert({
        code: upperCode,
        user_id: user.sub || user.id,
        credits: v.credits
      }).catch(() => {});
    }
    return res.status(200).json({
      ok: true,
      message: `✅ Voucher ${upperCode} resgatado! +${v.credits} créditos adicionados.`,
      credits: v.credits
    });
  }

  // ── Busca no Supabase (vouchers dinâmicos) ──
  if (supabase) {
    const { data: voucher } = await supabase
      .from('vouchers')
      .select('*')
      .eq('code', upperCode)
      .eq('used', false)
      .single();

    if (voucher) {
      await supabase.from('vouchers').update({
        used: true, used_by: user.sub || user.id
      }).eq('id', voucher.id);
      await supabase.from('users').update({ plan: voucher.plan }).eq('id', user.sub || user.id).catch(() => {});
      return res.status(200).json({
        ok: true,
        message: `✅ Voucher resgatado! Plano ${voucher.plan} ativado.`,
        plan: voucher.plan
      });
    }
  }

  return res.status(404).json({ error: 'Código inválido ou já utilizado.' });
};
