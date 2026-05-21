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

  // ── Vouchers hardcoded de créditos ──
  const STATIC_VOUCHERS = {
    'BETA2025':   { credits: 300,  type: 'credits' },
    'PREMIUM500': { credits: 500,  type: 'credits' },
    'VIP1000':    { credits: 1000, type: 'credits' },
  };

  // ── Código de acesso 30 dias ──
  const isAccess30 = upperCode.startsWith('ACC') || upperCode.startsWith('TRIAL') || upperCode.startsWith('FREE');

  if (isAccess30) {
    if (!supabase) return res.status(500).json({ error: 'Banco de dados não configurado.' });

    const { data: accCode, error: accErr } = await supabase
      .from('access_codes')
      .select('*')
      .eq('code', upperCode)
      .eq('used', false)
      .single();

    if (accErr || !accCode)
      return res.status(404).json({ error: 'Código inválido ou já utilizado.' });

    if (accCode.expires_at && new Date(accCode.expires_at) < new Date())
      return res.status(400).json({ error: 'Este código expirou.' });

    const validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + 30);

    await supabase.from('access_codes').update({
      used: true, used_by: userId, used_at: new Date().toISOString()
    }).eq('id', accCode.id);

    await supabase.from('users').update({
      plan: 'trial30',
      valid_until: validUntil.toISOString(),
      monthly_limit: accCode.monthly_limit || 5
    }).eq('id', userId).catch(() => {});

    const payload = { ...user, plan: 'trial30', valid_until: validUntil.toISOString(), lim_day: 5, monthly_limit: accCode.monthly_limit || 5 };
    delete payload.iat; delete payload.exp;
    const newToken = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '35d' });

    return res.status(200).json({
      ok: true,
      message: `✅ Acesso de 30 dias ativado! Válido até ${validUntil.toLocaleDateString('pt-BR')}.`,
      plan: 'trial30',
      valid_until: validUntil.toISOString(),
      new_token: newToken
    });
  }

  // ── Vouchers estáticos de créditos ──
  if (STATIC_VOUCHERS[upperCode]) {
    const v = STATIC_VOUCHERS[upperCode];

    // Verifica se já usou — com tratamento de erro robusto
    if (supabase) {
      try {
        const { data: usedVoucher, error: uvErr } = await supabase
          .from('used_vouchers')
          .select('id')
          .eq('code', upperCode)
          .eq('user_id', userId)
          .maybeSingle(); // maybeSingle: não lança erro se não achar

        if (uvErr) {
          // Tabela pode não existir — loga e ignora (não bloqueia o resgate)
          console.warn('[voucher-redeem] used_vouchers check error (ignorado):', uvErr.message);
        } else if (usedVoucher) {
          return res.status(400).json({ error: 'Você já usou este voucher.' });
        }
      } catch(e) {
        console.warn('[voucher-redeem] used_vouchers exception (ignorado):', e.message);
      }

      // Registra uso — com try/catch para não quebrar se tabela não existir
      try {
        await supabase.from('used_vouchers').insert({
          code: upperCode,
          user_id: userId,
          credits: v.credits,
          used_at: new Date().toISOString()
        });
      } catch(e) {
        console.warn('[voucher-redeem] used_vouchers insert error (ignorado):', e.message);
      }

      // Adiciona créditos ao usuário na tabela users
      try {
        // Busca créditos atuais
        const { data: userData } = await supabase
          .from('users')
          .select('credits')
          .eq('id', userId)
          .single();

        const currentCredits = userData?.credits || 0;
        await supabase.from('users').update({
          credits: currentCredits + v.credits
        }).eq('id', userId);
      } catch(e) {
        console.warn('[voucher-redeem] credits update error:', e.message);
      }
    }

    return res.status(200).json({
      ok: true,
      message: `✅ Voucher ${upperCode} resgatado! +${v.credits} créditos adicionados.`,
      credits: v.credits
    });
  }

  // ── Vouchers dinâmicos no Supabase ──
  if (supabase) {
    try {
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

      if (voucher) {
        // Marca como usado
        await supabase.from('vouchers').update({
          used: true, used_by: userId, used_at: new Date().toISOString()
        }).eq('id', voucher.id);

        // Atualiza plano do usuário — usa campo correto do banco
        // O campo pode ser 'plan', 'plano', 'tier' — tenta os três
        const planValue = voucher.plan || voucher.plano || voucher.tier || null;
        if (planValue) {
          await supabase.from('users').update({ plan: planValue }).eq('id', userId).catch(() => {});
        }

        // Se tiver créditos no voucher, adiciona
        if (voucher.credits) {
          const { data: userData } = await supabase.from('users').select('credits').eq('id', userId).single().catch(()=>({data:null}));
          const currentCredits = userData?.credits || 0;
          await supabase.from('users').update({ credits: currentCredits + voucher.credits }).eq('id', userId).catch(()=>{});
        }

        return res.status(200).json({
          ok: true,
          message: `✅ Voucher resgatado! ${planValue ? `Plano ${planValue} ativado.` : `+${voucher.credits||0} créditos adicionados.`}`,
          plan: planValue,
          credits: voucher.credits || 0
        });
      }
    } catch(e) {
      console.error('[voucher-redeem] exception:', e.message);
      return res.status(500).json({ error: 'Erro interno ao processar voucher.' });
    }
  }

  return res.status(404).json({ error: 'Código inválido ou já utilizado.' });
};
