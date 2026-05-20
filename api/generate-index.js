const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer '))
    return res.status(401).json({ error: 'Token não fornecido' });

  let user;
  try {
    user = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }

  const apiKey = process.env.DP_API_KEY;

  // ── GET: status do job ──
  if (req.method === 'GET') {
    const { job_id } = req.query;
    if (!job_id) return res.status(400).json({ error: 'job_id obrigatório' });

    try {
      const r = await fetch(`https://app.darkplanner.com.br/api/v1/audio/status/${job_id}`, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'X-API-Key': apiKey, 'Content-Type': 'application/json' }
      });
      const rawText = await r.text();
      let data;
      try { data = JSON.parse(rawText); } catch { data = { raw: rawText }; }

      const s = String(data.status || '').toLowerCase();
      if (['completed','done','success','finished'].includes(s)) data.status = 'done';
      else if (['failed','error','cancelled'].includes(s)) data.status = 'error';
      else data.status = 'processing';

      data.audio_url = data.audio_url || data.url || data.download_url || data.file_url || data.audio || null;
      return res.status(200).json(data);
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao verificar status', detail: err.message });
    }
  }

  // ── POST: gerar áudio ──
  if (req.method === 'POST') {
    const { text, voice_id } = req.body;
    if (!text || !voice_id)
      return res.status(400).json({ error: 'text e voice_id são obrigatórios' });

    if (text.length > 150000)
      return res.status(400).json({ error: 'Texto muito longo. Máximo 150.000 caracteres.' });

    // Verifica limite diário — com try/catch pra não quebrar se tabela não existir
    let usedToday = 0;
    try {
      const today = new Date().toISOString().split('T')[0];
      const { count, error: dbErr } = await supabase
        .from('audio_log')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.sub || user.id)
        .gte('created_at', `${today}T00:00:00`)
        .lte('created_at', `${today}T23:59:59`);

      if (!dbErr) usedToday = count || 0;
    } catch (e) {
      // ignora erro do Supabase — não bloqueia geração
      console.error('[limit-check] erro Supabase:', e.message);
    }

    if (usedToday >= (user.lim_day || 5))
      return res.status(429).json({ error: 'Limite diário atingido.' });

    try {
      const r = await fetch('https://app.darkplanner.com.br/api/v1/audio/generate', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'X-API-Key': apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ text, voice_id })
      });

      const rawText = await r.text();
      console.log('[generate] HTTP', r.status, '→', rawText.substring(0, 500));

      let data;
      try { data = JSON.parse(rawText); } catch { data = { raw: rawText }; }

      // Mostra campos recebidos se não tem job_id nem audio_url
      if (!data.job_id && !data.audio_url && !data.url && !data.id && !data.task_id) {
        return res.status(200).json({
          __debug: true,
          http_status: r.status,
          campos: Object.keys(data),
          resposta: data
        });
      }

      // Log no Supabase (silencioso)
      const jobId = data.job_id || data.id || data.task_id || null;
      supabase.from('audio_log').insert({
        user_id: user.sub || user.id,
        text: text.substring(0, 500),
        voice_id,
        job_id: jobId,
        status: jobId ? 'pendente' : 'erro'
      }).catch(() => {});

      data.audio_url = data.audio_url || data.url || data.download_url || data.file_url || data.audio || null;
      data.job_id    = data.job_id    || data.id  || data.task_id || null;

      return res.status(200).json(data);
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao gerar áudio', detail: err.message });
    }
  }

  return res.status(405).json({ error: 'Método não permitido' });
};
