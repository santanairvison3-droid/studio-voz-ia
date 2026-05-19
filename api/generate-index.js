const { verifyToken } = require('./_lib/auth');
const { supabase } = require('./_lib/supabase');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Não autorizado' });

  // Verificar status do job
  if (req.method === 'GET') {
    const { job_id } = req.query;
    if (!job_id) return res.status(400).json({ error: 'job_id obrigatório' });

    try {
      const response = await fetch(`https://app.darkplanner.com.br/api/v1/tts/status/${job_id}`, {
        headers: { 'Authorization': `Bearer ${process.env.DP_API_KEY}` }
      });
      const data = await response.json();
      return res.status(200).json(data);
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao verificar status', detail: err.message });
    }
  }

  // Gerar novo áudio
  if (req.method === 'POST') {
    const { text, voice_id } = req.body;

    if (!text || !voice_id) {
      return res.status(400).json({ error: 'text e voice_id são obrigatórios' });
    }

    try {
      const response = await fetch('https://app.darkplanner.com.br/api/v1/tts', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.DP_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ text, voice_id })
      });

      const data = await response.json();

      // Salvar log no Supabase
      await supabase.from('audio_log').insert({
        user_id:  user.sub,
        text:     text.substring(0, 500),
        voice_id,
        status:   data.job_id ? 'pendente' : 'erro'
      });

      return res.status(200).json(data);
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao gerar áudio', detail: err.message });
    }
  }

  return res.status(405).json({ error: 'Método não permitido' });
};
