const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const HARD_LIMIT = 50;

module.exports = async (req, res) => {
  // ── Garante que QUALQUER exceção retorna JSON — nunca HTML 500 do Vercel ──
  try {

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

  // ── Supabase ──
  let supabase = null;
  try {
    supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
  } catch(e) {
    console.error('[voucher-redeem] Supabase init error:', e.message);
  }

  const userId = user.sub || user.id;

  async function getUserData() {
    if (!supabase) return null;
    const { data, error } = await supabase
      .from('users')
      .select('credits, lim_day, daily_used, extra_audios')
      .eq('id', userId)
      .maybeSingle();
    if (error) { console.warn('[voucher-redeem] getUserData error:', error.message); return null; }
    return data;
  }

  async function addCredits(amount) {
    if (!supabase || !amount) return;
    try {
      const userData = await getUserData();
      const current = userData?.credits || 0;
      await supabase.from('users').update({ credits: current + amount }).eq('id', userId);
    } catch(e) {
      console.warn('[voucher-redeem] addCredits error:', e.message);
    }
  }

  async function addExtraAudios(amount) {
    if (!supabase || !amount) return 0;
    try {
      const userData = await getUserData();
      const currentLim = userData?.lim_day || 5;
      const currentExtra = userData?.extra_audios || 0;
      const newLim = Math.min(currentLim + amount, HARD_LIMIT);
      const actualAdded = newLim - currentLim;
      await supabase.from('users').update({
        lim_day: newLim,
        extra_audios: currentExtra + actualAdded
      }).eq('id', userId);
      return actualAdded;
    } catch(e) {
      console.warn('[voucher-redeem] addExtraAudios error:', e.message);
      return 0;
    }
  }

  // ── Código de acesso 30 dias ──
  const isAccess30 = upperCode.startsWith('ACC') || upperCode.startsWith('TRIAL') || upperCode.startsWith('FREE');

  if (isAccess30) {
    if (!supabase) return res.status(500).json({ error: 'Banco de dados não configurado.' });

    const { data: accCode, error: accErr } = await supabase
      .from('access_codes')
      .select('*')
      .eq('code', upperCode)
      .eq('used', false)
      .maybeSingle();

    if (accErr || !accCode)
      return res.status(404).json({ error: 'Código inválido ou já utilizado.' });

    if (accCode.expires_at && new Date(accCode.expires_at) < new Date())
      return res.status(400).json({ error: 'Este código expirou.' });

    const validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + 30);
    const planLimit = Math.min(accCode.monthly_limit || 5, HARD_LIMIT);

    await supabase.from('access_codes').update({
      used: true, used_by: userId, used_at: new Date().toISOString()
    }).eq('id', accCode.id);

    await supabase.from('users').update({
      plan: 'trial30',
      valid_until: validUntil.toISOString(),
      lim_day: planLimit,
      monthly_limit: planLimit
    }).eq('id', userId).catch(() => {});

    const payload = { ...user, plan: 'trial30', valid_until: validUntil.toISOString(), lim_day: planLimit };
    delete payload.iat; delete payload.exp;
    const newToken = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '35d' });

    return res.status(200).json({
      ok: true,
      message: `✅ Acesso de 30 dias ativado! Válido até ${validUntil.toLocaleDateString('pt-BR')}. Limite: ${planLimit} áudios/dia.`,
      plan: 'trial30',
      valid_until: validUntil.toISOString(),
      lim_day: planLimit,
      new_token: newToken
    });
  }

  // ── Vouchers hardcoded de créditos ──
  const STATIC_VOUCHERS = {
    'BETA2025':   { credits: 300,  type: 'credits' },
    'PREMIUM500': { credits: 500,  type: 'credits' },
    'VIP1000':    { credits: 1000, type: 'credits' },
  };

  if (STATIC_VOUCHERS[upperCode]) {
    const v = STATIC_VOUCHERS[upperCode];

    if (supabase) {
      const { data: usedVoucher, error: uvErr } = await supabase
        .from('used_vouchers')
        .select('id')
        .eq('code', upperCode)
        .eq('user_id', userId)
        .maybeSingle();

      if (!uvErr && usedVoucher)
        return res.status(400).json({ error: 'Você já usou este voucher.' });

      await supabase.from('used_vouchers').insert({
        code: upperCode, user_id: userId, credits: v.credits, used_at: new Date().toISOString()
      }).catch(e => console.warn('[voucher-redeem] used_vouchers insert:', e.message));

      await addCredits(v.credits);
    }

    return res.status(200).json({
      ok: true,
      message: `✅ Voucher ${upperCode} resgatado! +${v.credits} créditos adicionados.`,
      credits: v.credits
    });
  }

  // ── Vouchers dinâmicos no Supabase ──
  if (!supabase)
    return res.status(500).json({ error: 'Banco de dados não configurado.' });

  const { data: voucher, error: vErr } = await supabase
    .from('vouchers')
    .select('*')
    .eq('code', upperCode)
    .eq('used', false)
    .maybeSingle();

  if (vErr) {
    console.error('[voucher-redeem] vouchers query error:', vErr.message);
    return res.status(500).json({ error: 'Erro ao verificar voucher: ' + vErr.message });
  }

  if (!voucher)
    return res.status(404).json({ error: 'Código inválido ou já utilizado.' });

  // Marca como usado
  await supabase.from('vouchers').update({
    used: true, used_by: userId, used_at: new Date().toISOString()
  }).eq('id', voucher.id);

  let responseMsg = '✅ Voucher resgatado!';
  let responsePlan = null;
  let responseCredits = 0;
  let responseExtraAudios = 0;

  // Atualiza plano SOMENTE se não for vazio e não for "avulso"
  // "avulso" = entrega áudios extras sem alterar o plano do usuário
  const planValue = voucher.plan || voucher.plano || voucher.tier || null;
  if (planValue && planValue !== 'avulso') {
    const planLimits = { free: 3, basico: 5, premium: 10 };
    const newLim = Math.min(planLimits[planValue] ?? 5, HARD_LIMIT);
    await supabase.from('users').update({ plan: planValue, lim_day: newLim }).eq('id', userId).catch(() => {});
    responsePlan = planValue;
    responseMsg += ` Plano ${planValue} ativado (${newLim} áudios/dia).`;
  }

  // Adiciona créditos se tiver
  if (voucher.credits && voucher.credits > 0) {
    await addCredits(voucher.credits);
    responseCredits = voucher.credits;
    responseMsg += ` +${voucher.credits} créditos adicionados.`;
  }

  // Adiciona áudios extras se tiver
  if (voucher.extra_audios && voucher.extra_audios > 0) {
    responseExtraAudios = await addExtraAudios(voucher.extra_audios);
    if (responseExtraAudios > 0)
      responseMsg += ` +${responseExtraAudios} áudio(s) extra(s) liberado(s) hoje.`;
  }

  return res.status(200).json({
    ok: true,
    message: responseMsg,
    plan: responsePlan,
    credits: responseCredits,
    extra_audios: responseExtraAudios
  });

  // ── Catch global: evita HTML 500 do Vercel ──
  } catch(err) {
    console.error('[voucher-redeem] UNCAUGHT ERROR:', err.message, err.stack);
    return res.status(500).json({ error: 'Erro interno: ' + (err.message || 'desconhecido') });
  }
};
