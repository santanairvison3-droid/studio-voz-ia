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
    query, order = 'viewCount', region = 'BR',
    date = '', min_subs = '', max_subs = '',
    video_type = '', lang = '', page = '',
    duration = '', video_definition = '',
    min_views = '', min_dur = '',
    action = '', channel_url = '', qty = '50', ord = 'date'
  } = req.query;

  // ── INSIGHTS DE CANAL ──────────────────────────────────────────
  if (action === 'channel') {
    if (!channel_url) return res.status(400).json({ error: 'channel_url obrigatório' });
    try {
      // Extrai handle ou ID do canal da URL
      const handleMatch = channel_url.match(/@([\w.-]+)/);
      const idMatch = channel_url.match(/channel\/(UC[\w-]+)/);
      let channelId = '';

      if (handleMatch) {
        const r = await fetch(
          `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent('@'+handleMatch[1])}&type=channel&maxResults=1&key=${apiKey}`
        );
        const d = await r.json();
        channelId = d.items?.[0]?.snippet?.channelId || d.items?.[0]?.id?.channelId || '';
      } else if (idMatch) {
        channelId = idMatch[1];
      }

      if (!channelId) return res.status(404).json({ error: 'Canal não encontrado. Verifique a URL.' });

      // Info do canal
      const chRes = await fetch(
        `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${channelId}&key=${apiKey}`
      );
      const chData = await chRes.json();
      const chInfo = chData.items?.[0] || {};
      const chStats = chInfo.statistics || {};
      const chSnippet = chInfo.snippet || {};

      // Vídeos do canal
      const maxQty = Math.min(parseInt(qty) || 50, 200);
      const searchRes = await fetch(
        `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&type=video&order=${ord}&maxResults=50&key=${apiKey}`
      );
      const searchData = await searchRes.json();
      const items = searchData.items || [];
      if (!items.length) return res.status(200).json({ items: [], channel: {}, nextPage: '' });

      const videoIds = items.map(i => i.id?.videoId).filter(Boolean).join(',');
      const vRes = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id=${videoIds}&key=${apiKey}`
      );
      const vData = await vRes.json();
      const vMap = {};
      (vData.items || []).forEach(v => { vMap[v.id] = v; });

      const result = items.map(item => {
        const vid = item.id?.videoId;
        const snippet = item.snippet || {};
        const stats = vMap[vid]?.statistics || {};
        const details = vMap[vid]?.contentDetails || {};
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
        const pub = snippet.publishedAt ? new Date(snippet.publishedAt).toLocaleDateString('pt-BR') : '';
        return {
          id: vid,
          title: snippet.title || '',
          channel: snippet.channelTitle || '',
          channelId: snippet.channelId || '',
          thumbnail: snippet.thumbnails?.medium?.url || '',
          views: parseInt(stats.viewCount) || 0,
          likes: parseInt(stats.likeCount) || 0,
          subscribers: parseInt(chStats.subscriberCount) || 0,
          duration, videoType,
          published: pub,
          publishedRaw: snippet.publishedAt || '',
        };
      }).filter(v => v.id);

      return res.status(200).json({
        items: result,
        channel: {
          name: chSnippet.title || '',
          thumbnail: chSnippet.thumbnails?.medium?.url || '',
          subscribers: parseInt(chStats.subscriberCount) || 0,
          totalViews: parseInt(chStats.viewCount) || 0,
          videoCount: parseInt(chStats.videoCount) || 0,
        },
        nextPage: searchData.nextPageToken || ''
      });
    } catch (e) {
      console.error('[youtube/channel]', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── BUSCA DE VÍDEOS ────────────────────────────────────────────
  if (!query) return res.status(400).json({ error: 'query obrigatório' });

  try {
    // Filtro de data
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

    // Filtro de duração via API
    let videoDuration = '';
    if (duration === 'short') videoDuration = 'short';
    else if (duration === 'medium') videoDuration = 'medium';
    else if (duration === 'long') videoDuration = 'long';

    // Filtro de características
    let videoDefinition = '';
    if (video_definition === 'hd') videoDefinition = 'high';
    else if (video_definition === '4k') videoDefinition = 'high'; // 4K é subset de HD

    // Busca com maxResults maior para compensar filtragem posterior
    const maxResults = 25;

    const searchParams = new URLSearchParams({
      part: 'snippet',
      q: query,
      type: 'video',
      order,
      maxResults,
      key: apiKey,
      ...(region && { regionCode: region }),
      ...(lang && { relevanceLanguage: lang }),
      ...(publishedAfter && { publishedAfter }),
      ...(videoDuration && { videoDuration }),
      ...(videoDefinition && { videoDefinition }),
      ...(video_definition === 'live' && { eventType: 'live' }),
      ...(video_definition === 'subtitles' && { videoCaption: 'closedCaption' }),
      ...(video_definition === 'creativeCommons' && { videoLicense: 'creativeCommon' }),
      ...(video_definition === '3d' && { videoDimension: '3d' }),
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

    // Detalhes dos vídeos (statistics + contentDetails)
    const videoIds = items.map(i => i.id?.videoId).filter(Boolean).join(',');
    const videosRes = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id=${videoIds}&key=${apiKey}`
    );
    const videosData = await videosRes.json();
    const videoMap = {};
    (videosData.items || []).forEach(v => { videoMap[v.id] = v; });

    // Detalhes dos canais (inscritos)
    const channelIds = [...new Set(items.map(i => i.snippet?.channelId).filter(Boolean))].join(',');
    const channelsRes = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelIds}&key=${apiKey}`
    );
    const channelsData = await channelsRes.json();
    const channelMap = {};
    (channelsData.items || []).forEach(c => { channelMap[c.id] = c; });

    // Limites dos filtros
    const minSubsVal = parseInt(min_subs) || 0;
    const maxSubsVal = parseInt(max_subs) || 0;
    const minViewsVal = parseInt(min_views) || 0;
    const minDurSec = parseInt(min_dur) || 0;

    const result = items.map(item => {
      const vid = item.id?.videoId;
      const snippet = item.snippet || {};
      const stats = videoMap[vid]?.statistics || {};
      const details = videoMap[vid]?.contentDetails || {};
      const channelStats = channelMap[snippet.channelId]?.statistics || {};
      const subscribers = parseInt(channelStats.subscriberCount) || 0;

      // Duração ISO → mm:ss
      const dur = details.duration || '';
      const durMatch = dur.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
      let durationStr = '', totalSec = 0, videoType = 'medium';
      if (durMatch) {
        const h = parseInt(durMatch[1]) || 0;
        const m = parseInt(durMatch[2]) || 0;
        const s = parseInt(durMatch[3]) || 0;
        totalSec = h * 3600 + m * 60 + s;
        durationStr = h
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
        duration: durationStr,
        totalSec,
        videoType,
        published: pub,
        publishedRaw: snippet.publishedAt || '',  // ← ISO para o score viral
      };
    }).filter(v => {
      if (!v.id) return false;
      if (minSubsVal && v.subscribers < minSubsVal) return false;
      if (maxSubsVal && v.subscribers > maxSubsVal) return false;
      if (minViewsVal && v.views < minViewsVal) return false;         // ← views mínimas
      if (minDurSec && v.totalSec < minDurSec) return false;          // ← duração mínima
      if (video_type === 'short' && v.videoType !== 'short') return false;
      if (video_type === 'long' && v.videoType !== 'long') return false;
      return true;
    });

    // Ordena por views decrescente antes de retornar (melhor qualidade primeiro)
    result.sort((a, b) => b.views - a.views);

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
