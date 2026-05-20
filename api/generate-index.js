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
      // Manda os dois campos para garantir compatibilidade
      body: JSON.stringify({ text, voice_id, id: voice_id })
    });

    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = { raw }; }

    // Normaliza campos: DarkPlanner pode retornar audio_url, url, output, link, download_url
    const audioUrl = data.audio_url || data.url || data.output || data.link || data.download_url || null;
    // Normaliza job_id: pode vir como job_id, id, task_id, request_id
    const jobId = data.job_id || data.task_id || data.request_id || (typeof data.id === 'string' ? data.id : null);
    // Normaliza status
    const status = data.status || null;

    if (audioUrl) {
      return res.status(200).json({ audio_url: audioUrl, job_id: jobId });
    } else if (jobId) {
      return res.status(200).json({ job_id: jobId, status });
    } else {
      // Retorna debug pra facilitar diagnóstico
      return res.status(200).json({
        error: `DarkPlanner respondeu (HTTP ${response.status}) sem audio_url nem job_id`,
        campos_recebidos: Object.keys(data),
        resposta: data
      });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno: ' + err.message });
  }
};
