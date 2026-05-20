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
  const DP_BASE = 'https://app.darkplanner.com.br/api/v1/audio';
  const dpHeaders = { 'X-API-Key': apiKey, 'Content-Type': 'application/json' };

  // ── GET: status do job ──
  if (req.method === 'GET') {
    const { job_id } = req.query;
    if (!job_id) return res.status(400).json({ error: 'job_id obrigatório' });

    try {
      // 1. Verificar status
      const statusRes = await fetch(`${DP_BASE}/status/${job_id}`, { headers: dpHeaders });
      const statusText = await statusRes.text();
      let statusData;
      try { statusData = JSON.parse(statusText); } catch { statusData = { raw: statusText }; }

      const s = String(statusData.status || '').toLowerCase();

      if (['failed', 'error', 'cancelled'].includes(s)) {
        return res.status(200).json({ status: 'error', job_id });
      }

      if (['completed', 'done', 'success', 'finished'].includes(s)) {
        // 2. Buscar URL de download
        try {
          const dlRes = await fetch(`${DP_BASE}/download/${job_id}`, { headers: dpHeaders });
          const dlText = await dlRes.text();
          let dlData;
          try { dlData = JSON.parse(dlText); } catch { dlData = {}; }

          const audioUrl = dlData.audio_url || dlData.url || dlData.download_url || dlData.file_url || null;
          return res.status(200).json({
            status: 'done',
            job_id,
            audio_url: audioUrl,
            srt_url: dlData.srt_url || null,
            srt_veo_url: dlData.srt_veo_url || null
          });
        } catch (dlErr) {
          return res.status(200).json({ status: 'done', job_id, audio_url: null, error_download: dlErr.message });
        }
      }

      // Ainda processando
      return res.status(200).json({ status: 'processing', job_id });

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

    // Verifica limite diário
    let usedToday = 0;
    try {
      const today = new Date().toISOString().split('T')[0];
      const { count } = await supabase
        .from('audio_log')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.sub || user.id)
        .gte('created_at', `${today}T00:00:00`)
        .lte('created_at', `${today}T23:59:59`);
      usedToday = count || 0;
    } catch (e) {}

    if (usedToday >= (user.lim_day || 5))
      return res.status(429).json({ error: 'Limite diário atingido.' });

    try {
      const r = await fetch(`${DP_BASE}/generate`, {
        method: 'POST',
        headers: dpHeaders,
        body: JSON.stringify({ text, voice_id })
      });

      const rawText = await r.text();
      console.log('[generate] HTTP', r.status, rawText.substring(0, 400));

      let data;
      try { data = JSON.parse(rawText); } catch { data = { raw: rawText }; }

      const jobId = data.job_id || data.id || data.task_id || null;

      // Log no Supabase
      supabase.from('audio_log').insert({
        user_id: user.sub || user.id,
        text: text.substring(0, 500),
        voice_id,
        job_id: jobId,
        status: jobId ? 'pendente' : 'erro'
      }).catch(() => {});

      return res.status(200).json({
        success: data.success || !!jobId,
        job_id: jobId,
        status: data.status || 'processing',
        message: data.message || 'Áudio em processamento'
      });

    } catch (err) {
      return res.status(500).json({ error: 'Erro ao gerar áudio', detail: err.message });
    }
  }

  return res.status(405).json({ error: 'Método não permitido' });
};
