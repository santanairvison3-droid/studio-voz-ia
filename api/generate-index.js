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
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'X-API-Key': apiKey,
          'Content-Type': 'application/json'
        }
      });
      const data = await r.json();

      // Normaliza o status para o que o frontend espera (done / error)
      let normalized = { ...data };
      if (data.status) {
        const s = String(data.status).toLowerCase();
        if (s === 'completed' || s === 'done' || s === 'success' || s === 'finished') {
          normalized.status = 'done';
        } else if (s === 'failed' || s === 'error' || s === 'cancelled') {
          normalized.status = 'error';
        } else {
          normalized.status = 'processing';
        }
      }

      // Garante que audio_url aparece se tiver url/download_url/file_url
      if (!normalized.audio_url) {
        normalized.audio_url =
          data.url || data.download_url || data.file_url || data.audio || null;
      }

      return res.status(r.status).json(normalized);
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao verificar status', detail: err.message });
    }
  }

  // ── POST: gerar áudio ──
  if (req.method === 'POST') {
    const { text, voice_id } = req.body;
    if (!text || !voice_id)
      return res.status(400).json({ error: 'text e voice_id são obrigatórios' });

    // Limite: 5 áudios por dia por usuário
    const today = new Date().toISOString().split('T')[0];
    const { count } = await supabase
      .from('audio_log')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.sub || user.id)
      .gte('created_at', `${today}T00:00:00`)
      .lte('created_at', `${today}T23:59:59`);

    if (count >= (user.lim_day || 5))
      return res.status(429).json({ error: 'Limite diário atingido.' });

    if (text.length > 150000)
      return res.status(400).json({ error: 'Texto muito longo. Máximo 150.000 caracteres.' });

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

      const data = await r.json();

      // Log no Supabase
      await supabase.from('audio_log').insert({
        user_id:  user.sub || user.id,
        text:     text.substring(0, 500),
        voice_id,
        job_id:   data.job_id || null,
        status:   data.job_id ? 'pendente' : 'erro'
      }).catch(() => {});

      // Normaliza audio_url caso venha com outro nome
      let normalized = { ...data };
      if (!normalized.audio_url) {
        normalized.audio_url =
          data.url || data.download_url || data.file_url || data.audio || null;
      }

      return res.status(r.status).json(normalized);
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao gerar áudio', detail: err.message });
    }
  }

  return res.status(405).json({ error: 'Método não permitido' });
};
