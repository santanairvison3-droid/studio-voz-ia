const jwt = require('jsonwebtoken');

module.exports = async (req, res) => {
  // Auth check
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }
  const token = authHeader.split(' ')[1];
  try {
    jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }

  // ── GET: polling de status do job ──────────────────────────────
  if (req.method === 'GET') {
    const jobId = req.query.job_id;
    if (!jobId) return res.status(400).json({ error: 'job_id obrigatório' });

    try {
      // Tenta o endpoint de status do DarkPlanner
      const r = await fetch(`https://app.darkplanner.com.br/api/v1/audio/status/${jobId}`, {
        headers: { 'X-API-Key': process.env.DP_API_KEY }
      });
      const raw = await r.text();
      let data;
      try { data = JSON.parse(raw); } catch { data = { raw }; }

      // Normaliza campos de status
      const rawStatus = data.status || data.state || '';
      const isDone = ['done','completed','finished','success'].includes(rawStatus.toLowerCase());
      const isFail = ['error','failed','cancelled'].includes(rawStatus.toLowerCase());

      // Normaliza URL do áudio
      const audioUrl = data.audio_url || data.url || data.output || data.link || data.download_url || null;

      return res.status(200).json({
        status: isDone ? 'done' : isFail ? 'error' : 'processing',
        audio_url: audioUrl,
        job_id: jobId,
        _raw: rawStatus
      });
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao checar status: ' + err.message });
    }
  }

  // ── POST: gerar áudio ──────────────────────────────────────────
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, voice_id } = req.body || {};
  if (!text || !voice_id) {
    return res.status(400).json({ error: 'text e voice_id são obrigatórios' });
  }

  try {
    const response = await fetch('https://app.darkplanner.com.br/api/v1/audio/generate', {
      method: 'POST',
      headers: {
        'X-API-Key': process.env.DP_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text, voice_id, id: voice_id })
    });

    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = { raw }; }

    // Normaliza campos de retorno
    const audioUrl = data.audio_url || data.url || data.output || data.link || data.download_url || null;
    const jobId    = data.job_id || data.task_id || data.request_id || (typeof data.id === 'string' ? data.id : null);
    const rawStatus = data.status || '';
    const isDone = ['done','completed','finished','success'].includes((rawStatus||'').toLowerCase());

    if (audioUrl) {
      return res.status(200).json({ audio_url: audioUrl, job_id: jobId });
    } else if (isDone && jobId) {
      return res.status(200).json({ audio_url: `https://app.darkplanner.com.br/api/v1/audio/download/${jobId}`, job_id: jobId });
    } else if (jobId) {
      return res.status(200).json({ job_id: jobId, status: rawStatus });
    } else {
      return res.status(200).json({
        error: `DarkPlanner (HTTP ${response.status}) sem audio_url nem job_id`,
        campos: Object.keys(data),
        resposta: data
      });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno: ' + err.message });
  }
};
