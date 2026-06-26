const jwt = require('jsonwebtoken');

// ── Helpers ────────────────────────────────────────────────────────────────
// Usa timezone do Brasil (America/Sao_Paulo) para evitar reset no horário errado
function getTodayBR() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

// ── DarkPlanner: múltiplas chaves c/ FAILOVER (1 conta = ~50 áudios/dia) ──
// Devolve as contas do usuário EM ORDEM DE PRIORIDADE: a "casa" dele (hash do id)
// primeiro, depois as outras. Na geração, se a conta primária estourar a cota, o
// sistema cai pra próxima. No download, como o job pode ter sido criado em qualquer
// conta, tentamos as chaves até achar a que reconhece o job_id.
function dpKeysFor(uid) {
  const keys = [process.env.DP_API_KEY, process.env.DP_API_KEY_2].filter(Boolean);
  if (keys.length <= 1) return keys;
  const s = String(uid || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const primary = h % keys.length;
  return [keys[primary], ...keys.filter((_, i) => i !== primary)];
}
const dpHdr = k => ({ 'X-API-Key': k, 'Content-Type': 'application/json' });

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

  // ── Contas DarkPlanner do usuário (em ordem de prioridade, com failover) ──
  const dpKeys = dpKeysFor(user.sub || user.id);
  if (!dpKeys.length) {
    return res.status(500).json({
      error: 'DP_API_KEY não configurada no Vercel',
      detail: 'Vá em Settings > Environment Variables e adicione DP_API_KEY (e, opcionalmente, DP_API_KEY_2)'
    });
  }

  const DP_BASE = 'https://app.darkplanner.com.br/api/v1/audio';

  // ── GET: polling de status ──
  if (req.method === 'GET') {
    const { job_id } = req.query;
    if (!job_id) return res.status(400).json({ error: 'job_id obrigatório' });

    try {
      // Failover: o job pode estar em qualquer conta — tenta as chaves até a que o reconhece.
      let statusRes, statusText = '', usedKey = dpKeys[0];
      for (const k of dpKeys) {
        statusRes = await fetch(`${DP_BASE}/status/${job_id}`, { headers: dpHdr(k) });
        statusText = await statusRes.text();
        usedKey = k;
        if (statusRes.ok) break; // essa é a conta dona do job
      }
      let statusData = {};
      try { statusData = JSON.parse(statusText); } catch {}

      console.log('[status]', job_id, '->', statusRes.status, statusText.substring(0, 200));

      const s = String(statusData.status || '').toLowerCase();

      if (['failed', 'error', 'cancelled'].includes(s)) {
        return res.status(200).json({ status: 'error', job_id });
      }

      if (['completed', 'done', 'success', 'finished'].includes(s)) {
        const dlRes = await fetch(`${DP_BASE}/download/${job_id}`, { headers: dpHdr(usedKey) });
        const dlText = await dlRes.text();
        let dlData = {};
        try { dlData = JSON.parse(dlText); } catch {}

        console.log('[download]', job_id, '->', dlRes.status, dlText.substring(0, 200));

        const audioUrl = dlData.audio_url || dlData.url || null;

        // Atualiza audio_log com audio_url e status final
        if (audioUrl) {
          try {
            const { createClient } = require('@supabase/supabase-js');
            const sb = createClient(
              process.env.NEXT_PUBLIC_SUPABASE_URL,
              process.env.SUPABASE_SERVICE_KEY
            );
            await sb.from('audio_log')
              .update({ audio_url: audioUrl, status: 'concluido' })
              .eq('job_id', job_id);
          } catch (_) {}
        }

        return res.status(200).json({
          status:    'done',
          job_id,
          audio_url: audioUrl,
          srt_url:   dlData.srt_url || null
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
    // FIX: dbUser declarado no escopo do POST (não só dentro do if) para que a
    // devolução de crédito em caso de erro do DarkPlanner consiga lê-lo.
    let supabase, dbUser;

    if (!isAdmin) {
      try {
        const { createClient } = require('@supabase/supabase-js');
        supabase = createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL,
          process.env.SUPABASE_SERVICE_KEY
        );

        // Data no horário do Brasil (UTC-3) — mesma lógica do auth.js
        const today = getTodayBR();

        const { data: dbUserRow, error: userErr } = await supabase
          .from('users')
          .select('lim_day, daily_used, last_reset, status, plan')
          .eq('id', uid)
          .single();
        dbUser = dbUserRow;

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
          // FIX: Não sobrescreve lim_day customizado — só reseta o contador diário.
          // lim_day definido pelo admin é preservado; usa limite do plano só como fallback.
          const PLAN_LIMITS = { free: 3, basico: 5, premium: 10 };
          const planLim = PLAN_LIMITS[dbUser.plan] ?? 5;
          const resetLim = dbUser.lim_day ?? Math.min(planLim, 50);

          await supabase.from('users')
            .update({ daily_used: 0, last_reset: today })
            .eq('id', uid);

          dbUser.daily_used = 0;
          dbUser.lim_day = resetLim;
          console.log(`[generate] Reset diário para uid=${uid}, limDay mantido=${resetLim}`);
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

        // ── Incremento atômico — bloqueia duplo disparo simultâneo ──────────
        // Só atualiza se daily_used ainda for o valor lido (evita consumo duplo
        // em caso de clique duplo ou duas requisições paralelas do mesmo usuário).
        const { data: updated, error: updateErr } = await supabase
          .from('users')
          .update({ daily_used: usedToday + 1, last_reset: today })
          .eq('id', uid)
          .eq('daily_used', usedToday)   // condição atômica: só passa UMA requisição
          .select('daily_used')
          .single();

        if (updateErr || !updated) {
          // Outra requisição simultânea já incrementou — rejeita esta
          console.warn(`[generate] Duplo disparo bloqueado para uid=${uid}`);
          return res.status(429).json({
            error: 'Requisição duplicada detectada. Aguarde um instante e tente novamente.',
            used: usedToday,
            limit: limDay
          });
        }

        // Log no audio_log — salva geração completa (não-bloqueante)
        (async () => {
          try {
            await supabase.from('audio_log').insert({
              user_id:      uid,
              voice_id:     voice_id,
              voice_name:   req.body.voice_name || null,
              text_preview: text.substring(0, 120),
              characters:   text.length,
              status:       'pendente'
            });
          } catch (_) {}
        })();

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

      // Failover: tenta a conta primária do usuário; se a cota estourar, cai pra próxima.
      let r, rawText = '';
      for (let ki = 0; ki < dpKeys.length; ki++) {
        r = await fetch(`${DP_BASE}/generate`, {
          method: 'POST',
          headers: dpHdr(dpKeys[ki]),
          body: JSON.stringify({ text, voice_id })
        });
        rawText = await r.text();
        const last = ki === dpKeys.length - 1;
        const quotaErr = r.status === 429 || r.status === 403
          || /limit|quota|cota|esgotad|exceed|insufficient|saldo/i.test(rawText);
        if (r.ok || !quotaErr || last) break;
        console.log(`[generate] conta ${ki + 1} sem cota (HTTP ${r.status}); tentando próxima conta...`);
      }
      console.log('[generate] HTTP', r.status, rawText.substring(0, 400));

      let data = {};
      try { data = JSON.parse(rawText); } catch { data = { raw: rawText }; }

      if (!r.ok) {
        // API falhou — devolve o crédito consumido de forma atômica
        // FIX: decremento direto sem SELECT intermediário, evita race condition na devolução
        if (!isAdmin && supabase) {
          try {
            const usedBefore = (dbUser && dbUser.daily_used != null) ? dbUser.daily_used : null;
            if (usedBefore !== null) {
              await supabase.from('users')
                .update({ daily_used: usedBefore })
                .eq('id', uid)
                .eq('daily_used', usedBefore + 1); // só reverte se nada mais mudou
            }
            console.log(`[generate] Crédito devolvido para uid=${uid} após erro da API`);
          } catch (e) {
            console.warn('[generate] Falha ao devolver crédito:', e.message);
          }
        }

        return res.status(r.status).json({
          error: `DarkPlanner retornou ${r.status}`,
          detail: rawText.substring(0, 300)
        });
      }

      const jobId = data.job_id || data.id || null;

      // Atualiza audio_log com job_id para rastreamento posterior
      if (!isAdmin && supabase && jobId) {
        (async () => {
          try {
            await supabase.from('audio_log')
              .update({ job_id: jobId, status: 'processando' })
              .eq('user_id', uid)
              .is('job_id', null)
              .order('created_at', { ascending: false })
              .limit(1);
          } catch (_) {}
        })();
      }

      return res.status(200).json({
        success: true,
        job_id:  jobId,
        status:  data.status || 'processing',
        message: data.message || 'Em processamento'
      });

    } catch (err) {
      console.error('[generate] EXCEPTION:', err.message);

      // Exceção na chamada — devolve o crédito de forma atômica
      // FIX: mesma abordagem: reverte para o valor anterior sem SELECT extra
      if (!isAdmin && supabase) {
        try {
          const usedBefore = (dbUser && dbUser.daily_used != null) ? dbUser.daily_used : null;
          if (usedBefore !== null) {
            await supabase.from('users')
              .update({ daily_used: usedBefore })
              .eq('id', uid)
              .eq('daily_used', usedBefore + 1);
          }
        } catch {}
      }

      return res.status(500).json({ error: 'Erro ao contactar DarkPlanner', detail: err.message });
    }
  }

  return res.status(405).json({ error: 'Método não permitido' });
};
