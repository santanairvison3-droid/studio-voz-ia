const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer '))
    return res.status(401).json({ error: 'Não autorizado' });

  let user;
  try { user = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Token inválido' }); }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
  const uid = user.sub || user.id;

  // ── GET: lista histórico da nuvem ──────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('audio_log')
        .select('id, voice_id, voice_name, text_preview, audio_url, job_id, characters, created_at')
        .eq('user_id', uid)
        .not('audio_url', 'is', null)
        .order('created_at', { ascending: false })
        .limit(100);

      if (error) throw error;
      return res.status(200).json({ items: data || [] });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST: salva item no histórico ──────────────────────────────────────
  if (req.method === 'POST') {
    const { voice_id, voice_name, text_preview, audio_url, job_id, characters } = req.body || {};

    try {
      // Evita duplicata pelo job_id se já existir
      if (job_id) {
        const { data: existing } = await supabase
          .from('audio_log')
          .select('id')
          .eq('job_id', job_id)
          .eq('user_id', uid)
          .maybeSingle();
        if (existing) {
          // Só atualiza audio_url se veio preenchido
          if (audio_url) {
            await supabase.from('audio_log')
              .update({ audio_url, status: 'concluido' })
              .eq('id', existing.id);
          }
          return res.status(200).json({ ok: true, updated: true });
        }
      }

      const { error } = await supabase.from('audio_log').insert({
        user_id:      uid,
        voice_id:     voice_id     || null,
        voice_name:   voice_name   || null,
        text_preview: text_preview || null,
        audio_url:    audio_url    || null,
        job_id:       job_id       || null,
        characters:   characters   || 0,
        status:       audio_url ? 'concluido' : 'pendente'
      });

      if (error) throw error;
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Método não permitido' });
};
