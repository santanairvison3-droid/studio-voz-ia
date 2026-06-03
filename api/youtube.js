const jwt = require('jsonwebtoken');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer '))
    return res.status(401).json({ error: 'Não autorizado' });

  try { jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Token inválido' }); }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'YOUTUBE_API_KEY não configurada no Vercel.' });

  const {
    query, order = 'relevance', region = 'BR',
    date = '', min_subs = '', max_subs = '',
    video_type = '', lang = '', page = ''
  } = req.query;

  if (!query) return res.status(400).json({ error: 'query obrigatório' });

  try {
    // ── Filtro de data ────────────────────────────────────────────
    let publishedAfter = '';
    if (date) {
      const now = new Date();
      const map = { today: 1, week: 7, month: 30, year: 365 };
      const days = map[date] || 0;
      if (days) {
        now.setTime(now.getTime() - days * 24 * 60 * 60 * 1000);
        publishedAfter = now.toISOString();
      }
    }

    // ── Filtro de duração (Shorts / médio / longo) ────────────────
    let videoDuration = '';
    if (video_type === 'short') videoDuration = 'short';      // até 4min no YT (Shorts)
    else if (video_type === 'medium') videoDuration = 'medium'; // 4-20min
    else if (video_type === 'long') videoDuration = 'long';     // 20min+

    // ── Busca vídeos ──────────────────────────────────────────────
    const searchParams = new URLSearchParams({
      part: 'snippet',
      q: query,
      type: 'video',
      order,
      maxResults: 12,
      key: apiKey,
      ...(region && { regionCode: region }),
      ...(lang && { relevanceLanguage: lang }),
      ...(publishedAfter && { publishedAfter }),
      ...(videoDuration && { videoDuration }),
      ...(page && { pageToken: page }),
    });

    const searchRes = await fetch(`https://www.googleapis.com/youtube/v3/search?${searchParams}`);
    const searchData = await searchRes.json();

    if (!searchRes.ok) {
      console.error('[youtube] search error:', JSON.stringify(searchData));
      return res.status(500).json({ error: searchData.error?.message || 'Erro na API do YouTube' });
    }

    const items = searchData.items || [];
    if (!items.length) return res.status(200).json({ items: [], nextPage: '' });

    // ── Detalhes dos vídeos ───────────────────────────────────────
    const videoIds = items.map(i => i.id?.videoId).filter(Boolean).join(',');
    const videosRes = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id=${videoIds}&key=${apiKey}`
    );
    const videosData = await videosRes.json();
    const videoMap = {};
    (videosData.items || []).forEach(v => { videoMap[v.id] = v; });

    // ── Detalhes dos canais ───────────────────────────────────────
    const channelIds = [...new Set(items.map(i => i.snippet?.channelId).filter(Boolean))].join(',');
    const channelsRes = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelIds}&key=${apiKey}`
    );
    const channelsData = await channelsRes.json();
    const channelMap = {};
    (channelsData.items || []).forEach(c => { channelMap[c.id] = c; });

    // ── Monta resultado ───────────────────────────────────────────
    const minSubs = parseInt(min_subs) || 0;
    const maxSubsVal = parseInt(max_subs) || 0;

    const result = items.map(item => {
      const vid = item.id?.videoId;
      const snippet = item.snippet || {};
      const stats = videoMap[vid]?.statistics || {};
      const details = videoMap[vid]?.contentDetails || {};
      const channelStats = channelMap[snippet.channelId]?.statistics || {};
      const subscribers = parseInt(channelStats.subscriberCount) || 0;

      // Duração ISO → mm:ss + tipo
      const dur = details.duration || '';
      const durMatch = dur.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
      let duration = '', totalSec = 0, videoType = 'medium';
      if (durMatch) {
        const h = parseInt(durMatch[1]) || 0;
        const m = parseInt(durMatch[2]) || 0;
        const s = parseInt(durMatch[3]) || 0;
        totalSec = h * 3600 + m * 60 + s;
        duration = h
          ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
          : `${m}:${String(s).padStart(2,'0')}`;
        if (totalSec <= 60) videoType = 'short';
        else if (totalSec >= 1200) videoType = 'long';
      }

      const pub = snippet.publishedAt
        ? new Date(snippet.publishedAt).toLocaleDateString('pt-BR') : '';

      return {
        id: vid,
        title: snippet.title || '',
        channel: snippet.channelTitle || '',
        channelId: snippet.channelId || '',
        thumbnail: snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || '',
        views: parseInt(stats.viewCount) || 0,
        likes: parseInt(stats.likeCount) || 0,
        subscribers,
        duration,
        videoType,
        published: pub,
        publishedAt: snippet.publishedAt || '',
      };
    }).filter(v => {
      if (!v.id) return false;
      if (minSubs && v.subscribers < minSubs) return false;
      if (maxSubsVal && v.subscribers > maxSubsVal) return false;
      // Filtro de tipo pelo backend também (reforça o videoDuration da API)
      if (video_type === 'short' && v.videoType !== 'short') return false;
      if (video_type === 'long' && v.videoType !== 'long') return false;
      return true;
    });

    return res.status(200).json({
      items: result,
      nextPage: searchData.nextPageToken || '',
      total: searchData.pageInfo?.totalResults || 0
    });

  } catch (e) {
    console.error('[youtube]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
