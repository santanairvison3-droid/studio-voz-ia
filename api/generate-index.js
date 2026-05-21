const jwt = require('jsonwebtoken');

// ── Helpers ────────────────────────────────────────────────────────────────
// Usa timezone do Brasil (America/Sao_Paulo) para evitar reset no horário errado
function getTodayBR() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── CORS ──
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // ── Auth ──
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer '))
    return res.status(401).json({ error: 'Token não fornecido' });

  let user;
  try {
    user = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }

  // ── Verifica DP_API_KEY ──
  const apiKey = process.env.DP_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'DP_API_KEY não configurada no Vercel',
      detail: 'Vá em Settings > Environment Variables e adicione DP_API_KEY'
    });
  }

  const DP_BASE = 'https://app.darkplanner.com.br/api/v1/audio';
  const dpHeaders = { 'X-API-Key': apiKey, 'Content-Type': 'application/json' };

  // ── GET: polling de status ──
  if (req.method === 'GET') {
    const { job_id } = req.query;
    if (!job_id) return res.status(400).json({ error: 'job_id obrigatório' });

    try {
      const statusRes = await fetch(`${DP_BASE}/status/${job_id}`, { headers: dpHeaders });
      const statusText = await statusRes.text();
      let statusData = {};
      try { statusData = JSON.parse(statusText); } catch {}

      console.log('[status]', job_id, '->', statusRes.status, statusText.substring(0, 200));

      const s = String(statusData.status || '').toLowerCase();

      if (['failed', 'error', 'cancelled'].includes(s)) {
        return res.status(200).json({ status: 'error', job_id });
      }

      if (['completed', 'done', 'success', 'finished'].includes(s)) {
        const dlRes = await fetch(`${DP_BASE}/download/${job_id}`, { headers: dpHeaders });
        const dlText = await dlRes.text();
        let dlData = {};
        try { dlData = JSON.parse(dlText); } catch {}

        console.log('[download]', job_id, '->', dlRes.status, dlText.substring(0, 200));

        return res.status(200).json({
          status: 'done',
          job_id,
          audio_url: dlData.audio_url || dlData.url || null,
          srt_url: dlData.srt_url || null
        });
      }

      return res.status(200).json({ status: 'processing', job_id });

    } catch (err) {
      return res.status(500).json({ error: 'Erro ao verificar status', detail: err.message });
    }
  }

  // ── POST: gerar áudio ──
  if (req.method === 'POST') {
    const { text, voice_id } = req.body || {};

    if (!text || !voice_id)
      return res.status(400).json({
        error: 'text e voice_id são obrigatórios',
        recebido: { text: !!text, voice_id: !!voice_id }
      });

    if (text.length > 150000)
      return res.status(400).json({ error: 'Texto muito longo (máx 150.000 chars).' });

    // ══════════════════════════════════════════════
    // VERIFICAÇÃO DE LIMITE DIÁRIO (via Supabase)
    // Admin ignora o limite completamente
    // ══════════════════════════════════════════════
    const isAdmin = user.role === 'admin';
    const uid = user.sub || user.id;
    let supabase;

    if (!isAdmin) {
      try {
        const { createClient } = require('@supabase/supabase-js');
        supabase = createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL,
          process.env.SUPABASE_SERVICE_KEY
        );

        // Data no horário do Brasil (UTC-3) — mesma lógica do auth.js
        const today = getTodayBR();

        const { data: dbUser, error: userErr } = await supabase
          .from('users')
          .select('lim_day, daily_used, last_reset, status, plan')
          .eq('id', uid)
          .single();

        if (userErr || !dbUser) {
          return res.status(401).json({ error: 'Usuário não encontrado.' });
        }

        if (['suspenso', 'suspended', 'blocked'].includes(dbUser.status)) {
          return res.status(403).json({ error: 'Conta suspensa. Entre em contato com o suporte.' });
        }

        const lastReset = dbUser.last_reset
          ? String(dbUser.last_reset).split('T')[0]
          : null;

        // ── Reset automático: novo dia detectado ──
        if (lastReset !== today) {
          const PLAN_LIMITS = { free: 3, basico: 5, premium: 10 };
          const planLim = PLAN_LIMITS[dbUser.plan] ?? 5;
          const resetLim = Math.min(planLim, 50);

          await supabase.from('users')
            .update({ daily_used: 0, last_reset: today, lim_day: resetLim })
            .eq('id', uid);

          dbUser.daily_used = 0;
          dbUser.lim_day = resetLim;
          console.log(`[generate] Reset diário para uid=${uid}, limDay=${resetLim}`);
        }

        // limDay lido DEPOIS do possível reset
        const limDay = dbUser.lim_day || 5;
        const usedToday = dbUser.daily_used || 0;

        // ── Verifica limite ──
        if (usedToday >= limDay) {
          return res.status(429).json({
            error: `Limite diário atingido. Você usou ${usedToday} de ${limDay} áudios hoje.`,
            used: usedToday,
            limit: limDay,
            reset: 'meia-noite (horário de Brasília)'
          });
        }

        // ── Incremento simples e confiável ──────────────────────────────────
        // NOTA: Não usar incremento atômico com .lt() + count — o Supabase
        // não retorna contagem correta em updates com filtro encadeado,
        // causando consumo de crédito sem gerar áudio.
        const { error: updateErr } = await supabase
          .from('users')
          .update({ daily_used: usedToday + 1, last_reset: today })
          .eq('id', uid);

        if (updateErr) {
          console.error('[generate] Erro ao incrementar daily_used:', updateErr.message);
          return res.status(500).json({ error: 'Erro ao registrar uso. Tente novamente.' });
        }

        // Log no audio_log (não-bloqueante)
        supabase.from('audio_log').insert({
          user_id: uid,
          text: text.substring(0, 500),
          voice_id,
          status: 'pendente'
        }).catch(() => {});

      } catch (e) {
        console.warn('[supabase limite] erro:', e.message);
        return res.status(500).json({ error: 'Erro ao verificar limite. Tente novamente.' });
      }
    }
    // Admin: sem verificação de limite, vai direto para o DarkPlanner

    // ══════════════════════════════════════════════
    // Chama DarkPlanner
    // ══════════════════════════════════════════════
    try {
      console.log('[generate] POST voice_id:', voice_id, 'chars:', text.length, 'user:', uid, 'admin:', isAdmin);

      const r = await fetch(`${DP_BASE}/generate`, {
        method: 'POST',
        headers: dpHeaders,
        body: JSON.stringify({ text, voice_id })
      });

      const rawText = await r.text();
      console.log('[generate] HTTP', r.status, rawText.substring(0, 400));

      let data = {};
      try { data = JSON.parse(rawText); } catch { data = { raw: rawText }; }

      if (!r.ok) {
        // API falhou — devolve o crédito consumido
        if (!isAdmin && supabase) {
          try {
            const { data: cur } = await supabase
              .from('users')
              .select('daily_used')
              .eq('id', uid)
              .single();
            if (cur && cur.daily_used > 0) {
              await supabase.from('users')
                .update({ daily_used: cur.daily_used - 1 })
                .eq('id', uid);
              console.log(`[generate] Crédito devolvido para uid=${uid} após erro da API`);
            }
          } catch (e) {
            console.warn('[generate] Falha ao devolver crédito:', e.message);
          }
        }

        return res.status(r.status).json({
          error: `DarkPlanner retornou ${r.status}`,
          detail: rawText.substring(0, 300)
        });
      }

      return res.status(200).json({
        success: true,
        job_id: data.job_id || data.id || null,
        status: data.status || 'processing',
        message: data.message || 'Em processamento'
      });

    } catch (err) {
      console.error('[generate] EXCEPTION:', err.message);

      // Exceção na chamada — devolve o crédito
      if (!isAdmin && supabase) {
        try {
          const { data: cur } = await supabase
            .from('users')
            .select('daily_used')
            .eq('id', uid)
            .single();
          if (cur && cur.daily_used > 0) {
            await supabase.from('users')
              .update({ daily_used: cur.daily_used - 1 })
              .eq('id', uid);
          }
        } catch {}
      }

      return res.status(500).json({ error: 'Erro ao contactar DarkPlanner', detail: err.message });
    }
  }

  return res.status(405).json({ error: 'Método não permitido' });
};
