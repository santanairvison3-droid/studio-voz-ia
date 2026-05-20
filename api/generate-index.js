const jwt = require('jsonwebtoken');

const DP_BASE = 'https://app.darkplanner.com.br/api/v1/audio';

module.exports = async (req, res) => {
  // Auth — aceita header ou query string (para <audio src="...">)
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : (req.query.token || '');
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });
  try { jwt.verify(token, process.env.JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Token inválido' }); }

  const dpHeaders = {
    'X-API-Key': process.env.DP_API_KEY,
    'Content-Type': 'application/json'
  };

  // ── GET: checar status do job ─────────────────────────────────────
  if (req.method === 'GET') {
    const jobId = req.query.job_id;
    if (!jobId) return res.status(400).json({ error: 'job_id obrigatório' });

    try {
      // Passo 1: checar status
      const statusRes = await fetch(`${DP_BASE}/status/${jobId}`, { headers: dpHeaders });
      const statusData = await statusRes.json();

      if (statusData.status === 'completed') {
        // Passo 2: buscar URL do áudio
        const dlRes = await fetch(`${DP_BASE}/download/${jobId}`, { headers: dpHeaders });
        const dlData = await dlRes.json();

        return res.status(200).json({
          status: 'done',
          audio_url: dlData.audio_url || null,
          srt_url: dlData.srt_url || null,
          job_id: jobId
        });
      } else if (statusData.status === 'failed' || statusData.status === 'error') {
        return res.status(200).json({ status: 'error', job_id: jobId });
      } else {
        // ainda processando
        return res.status(200).json({ status: 'processing', job_id: jobId });
      }
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao checar status: ' + err.message });
    }
  }

  // ── POST: gerar áudio ─────────────────────────────────────────────
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, voice_id } = req.body || {};
  if (!text || !voice_id) return res.status(400).json({ error: 'text e voice_id são obrigatórios' });

  try {
    const response = await fetch(`${DP_BASE}/generate`, {
      method: 'POST',
      headers: dpHeaders,
      body: JSON.stringify({ text, voice_id })
    });

    const data = await response.json();
    // Resposta esperada: { success, job_id, status: "processing" }
    if (data.job_id) {
      return res.status(200).json({ job_id: data.job_id, status: data.status });
    } else {
      return res.status(200).json({
        error: 'Sem job_id na resposta',
        resposta: data
      });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno: ' + err.message });
  }
};
