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

  // Rota determinada pelo query param ?action=
  const action = req.query.action;

  // ══════════════════════════════════════════════════════════════
  // HISTÓRICO
  // GET  /api/user-data?action=history  → lista áudios
  // POST /api/user-data?action=history  → salva áudio
  // ══════════════════════════════════════════════════════════════
  if (action === 'history') {
    if (req.method === 'GET') {
      try {
        const { data, error } = await supabase
          .from('audio_log')
          .select('id,voice_id,voice_name,text_preview,audio_url,job_id,characters,created_at')
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
    if (req.method === 'POST') {
      const { voice_id, voice_name, text_preview, audio_url, job_id, characters } = req.body || {};
      try {
        if (job_id) {
          const { data: existing } = await supabase
            .from('audio_log').select('id').eq('job_id', job_id).eq('user_id', uid).maybeSingle();
          if (existing) {
            if (audio_url)
              await supabase.from('audio_log').update({ audio_url, status: 'concluido' }).eq('id', existing.id);
            return res.status(200).json({ ok: true, updated: true });
          }
        }
        const { error } = await supabase.from('audio_log').insert({
          user_id: uid, voice_id: voice_id||null, voice_name: voice_name||null,
          text_preview: text_preview||null, audio_url: audio_url||null,
          job_id: job_id||null, characters: characters||0,
          status: audio_url ? 'concluido' : 'pendente'
        });
        if (error) throw error;
        return res.status(200).json({ ok: true });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  // FAVORITAS
  // GET  /api/user-data?action=favorites → busca favoritas
  // POST /api/user-data?action=favorites → salva favoritas
  // ══════════════════════════════════════════════════════════════
  if (action === 'favorites') {
    if (req.method === 'GET') {
      try {
        const { data, error } = await supabase
          .from('users').select('favorites').eq('id', uid).single();
        if (error) throw error;
        return res.status(200).json({ favorites: data?.favorites || [] });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }
    if (req.method === 'POST') {
      const { favorites } = req.body || {};
      if (!Array.isArray(favorites))
        return res.status(400).json({ error: 'favorites deve ser um array' });
      try {
        const { error } = await supabase
          .from('users').update({ favorites: favorites.slice(0, 200) }).eq('id', uid);
        if (error) throw error;
        return res.status(200).json({ ok: true, count: favorites.length });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  // AVISOS
  // GET /api/user-data?action=notices → avisos ativos
  // ══════════════════════════════════════════════════════════════
  if (action === 'notices') {
    if (req.method === 'GET') {
      try {
        const plan = user.plan || 'free';
        const { data, error } = await supabase
          .from('notices')
          .select('id,title,message,type,target')
          .eq('active', true)
          .or(`target.eq.all,target.eq.${plan}`)
          .order('created_at', { ascending: false })
          .limit(5);
        if (error) throw error;
        return res.status(200).json({ notices: data || [] });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  // ESTATÍSTICAS
  // GET /api/user-data?action=stats → dados da vw_user_stats
  // ══════════════════════════════════════════════════════════════
  if (action === 'stats') {
    if (req.method === 'GET') {
      try {
        const { data, error } = await supabase
          .from('vw_user_stats').select('*').eq('user_id', uid).maybeSingle();
        if (error) throw error;
        if (!data) return res.status(200).json({
          stats: { total_audios:0, total_characters:0, audios_last_30d:0, audios_today:0, top_voices:[], last_7_days:[] }
        });
        return res.status(200).json({ stats: data });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  // HISTÓRICO DE BUSCAS / PERFIL DO USUÁRIO (Tendências)
  // POST /api/user-data?action=searches  → registra uma busca
  // GET  /api/user-data?action=searches  → devolve perfil agregado
  // ══════════════════════════════════════════════════════════════
  if (action === 'searches') {
    if (req.method === 'POST') {
      const { query, region, lang, video_type, source } = req.body || {};
      const q = String(query || '').trim();
      if (q.length < 2) return res.status(200).json({ ok: true, skipped: true });
      const queryNorm = q.toLowerCase().slice(0, 120);
      try {
        const { data: existing } = await supabase
          .from('search_log').select('id, count')
          .eq('user_id', uid).eq('query_norm', queryNorm).maybeSingle();
        if (existing) {
          await supabase.from('search_log').update({
            count: (existing.count || 1) + 1,
            last_at: new Date().toISOString(),
            region: region || null, lang: lang || null,
            video_type: video_type || null, source: source || null
          }).eq('id', existing.id);
        } else {
          await supabase.from('search_log').insert({
            user_id: uid, query: q.slice(0, 120), query_norm: queryNorm,
            region: region || null, lang: lang || null,
            video_type: video_type || null, source: source || null
          });
        }
        return res.status(200).json({ ok: true });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }
    if (req.method === 'GET') {
      try {
        const { data, error } = await supabase
          .from('search_log')
          .select('query, query_norm, region, lang, video_type, count, last_at')
          .eq('user_id', uid)
          .order('last_at', { ascending: false })
          .limit(200);
        if (error) throw error;
        const rows = data || [];

        // Buscas recentes (queries distintas, mais novas primeiro)
        const recent = rows.map(r => r.query).filter(Boolean).slice(0, 12);

        // Nicho: palavras mais frequentes (pondera pelo count de cada busca)
        const STOP = new Set(['de','a','o','e','que','do','da','em','um','uma','para','com','no','na','os','as','por','se','the','to','of','and','my','i','you','is','it','how','el','la','los','las','un','con','su','pra','mais','sua','seu','voce','você','dos','das','para','como']);
        const freq = {};
        rows.forEach(r => {
          const w = (r.count || 1);
          String(r.query_norm || '').replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).forEach(word => {
            if (word.length >= 3 && !STOP.has(word)) freq[word] = (freq[word] || 0) + w;
          });
        });
        const keywords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 12).map(x => x[0]);

        // Valor mais frequente de region/lang/video_type (default do usuário)
        const mode = (field) => {
          const c = {};
          rows.forEach(r => { const v = r[field]; if (v) c[v] = (c[v] || 0) + (r.count || 1); });
          const top = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
          return top ? top[0] : null;
        };

        return res.status(200).json({
          recent, keywords,
          region: mode('region'), lang: mode('lang'), video_type: mode('video_type'),
          total: rows.length
        });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }
  }

  return res.status(400).json({ error: 'action inválida. Use: history, favorites, notices, stats, searches' });
};
