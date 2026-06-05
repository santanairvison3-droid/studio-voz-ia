const jwt = require('jsonwebtoken');

// Score viral calculado no servidor para ordenar os resultados
function viralScore(v) {
  const views = v.views || 0;
  const subs = Math.max(v.subscribers, 1);
  const pub = v.publishedRaw ? new Date(v.publishedRaw) : null;
  const daysSince = pub ? Math.max(1, Math.round((Date.now() - pub) / 86400000)) : 90;
  const ratio = views / subs;
  const vpd = views / daysSince;

  let score = 0;
  score += ratio >= 20 ? 40 : ratio >= 10 ? 35 : ratio >= 5 ? 28 : ratio >= 2 ? 20 : ratio >= 1 ? 12 : 6;
  score += vpd >= 500000 ? 30 : vpd >= 100000 ? 26 : vpd >= 10000 ? 20 : vpd >= 1000 ? 14 : vpd >= 100 ? 8 : 4;
  score += subs < 5000 ? 20 : subs < 20000 ? 16 : subs < 100000 ? 12 : subs < 500000 ? 6 : 2;
  score += daysSince <= 3 ? 10 : daysSince <= 7 ? 9 : daysSince <= 14 ? 7 : daysSince <= 30 ? 5 : daysSince <= 90 ? 3 : 1;
  return Math.min(100, score);
}

function parseDuration(isoStr) {
  const m = (isoStr || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return { durationStr: '', totalSec: 0, videoType: 'medium' };
  const h = parseInt(m[1]) || 0;
  const min = parseInt(m[2]) || 0;
  const s = parseInt(m[3]) || 0;
  const totalSec = h * 3600 + min * 60 + s;
  const durationStr = h
    ? `${h}:${String(min).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${min}:${String(s).padStart(2, '0')}`;
  const videoType = totalSec <= 60 ? 'short' : totalSec >= 1200 ? 'long' : 'medium';
  return { durationStr, totalSec, videoType };
}

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
      const handleMatch = channel_url.match(/@([\w.-]+)/);
      const idMatch = channel_url.match(/channel\/(UC[\w-]+)/);
      let channelId = '';

      if (handleMatch) {
        const r = await fetch(
          `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent('@' + handleMatch[1])}&type=channel&maxResults=1&key=${apiKey}`
        );
        const d = await r.json();
        channelId = d.items?.[0]?.snippet?.channelId || d.items?.[0]?.id?.channelId || '';
      } else if (idMatch) {
        channelId = idMatch[1];
      }

      if (!channelId) return res.status(404).json({ error: 'Canal não encontrado. Verifique a URL.' });

      const [chRes, searchRes] = await Promise.all([
        fetch(`https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${channelId}&key=${apiKey}`),
        fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&type=video&order=${ord}&maxResults=50&key=${apiKey}`)
      ]);
      const [chData, searchData] = await Promise.all([chRes.json(), searchRes.json()]);

      const chInfo = chData.items?.[0] || {};
      const chStats = chInfo.statistics || {};
      const chSnippet = chInfo.snippet || {};
      const items = searchData.items || [];
      if (!items.length) return res.status(200).json({ items: [], channel: {}, nextPage: '' });

      const videoIds = items.map(i => i.id?.videoId).filter(Boolean).join(',');
      const vRes = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id=${videoIds}&key=${apiKey}`
      );
      const vData = await vRes.json();
      const vMap = {};
      (vData.items || []).forEach(v => { vMap[v.id] = v; });

      const chSubscribers = parseInt(chStats.subscriberCount) || 0;

      const result = items.map(item => {
        const vid = item.id?.videoId;
        if (!vid) return null;
        const snippet = item.snippet || {};
        const stats = vMap[vid]?.statistics || {};
        const { durationStr, totalSec, videoType } = parseDuration(vMap[vid]?.contentDetails?.duration);
        const pub = snippet.publishedAt ? new Date(snippet.publishedAt).toLocaleDateString('pt-BR') : '';
        const v = {
          id: vid,
          title: snippet.title || '',
          channel: snippet.channelTitle || '',
          channelId: snippet.channelId || '',
          thumbnail: snippet.thumbnails?.medium?.url || '',
          views: parseInt(stats.viewCount) || 0,
          likes: parseInt(stats.likeCount) || 0,
          subscribers: chSubscribers,
          duration: durationStr,
          totalSec, videoType,
          published: pub,
          publishedRaw: snippet.publishedAt || '',
        };
        return v;
      }).filter(Boolean);

      result.sort((a, b) => viralScore(b) - viralScore(a));

      return res.status(200).json({
        items: result,
        channel: {
          name: chSnippet.title || '',
          thumbnail: chSnippet.thumbnails?.medium?.url || '',
          subscribers: chSubscribers,
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
      const days = { today: 1, week: 7, month: 30, year: 365 }[date] || 0;
      if (days) {
        now.setTime(now.getTime() - days * 86400000);
        publishedAfter = now.toISOString();
      }
    }

    // Tipo de busca: channel e playlist são passados direto para a API
    const ytType = video_type === 'channel' ? 'channel'
                 : video_type === 'playlist' ? 'playlist'
                 : 'video';

    // Duração: filtro explícito tem prioridade; Shorts força 'short' na API
    let videoDuration = '';
    if (duration === 'short' || duration === 'medium' || duration === 'long') {
      videoDuration = duration;
    } else if (video_type === 'short') {
      videoDuration = 'short';
    }

    // Características de vídeo
    let videoDefinition = '';
    if (video_definition === 'hd' || video_definition === '4k') videoDefinition = 'high';

    const searchParams = new URLSearchParams({
      part: 'snippet',
      q: query,
      type: ytType,
      order,
      maxResults: 50,
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

    // Busca stats de vídeos e canais em paralelo
    const videoIds = items.map(i => i.id?.videoId).filter(Boolean).join(',');
    const channelIds = [...new Set(items.map(i => i.snippet?.channelId).filter(Boolean))].join(',');

    const [videosRes, channelsRes] = await Promise.all([
      fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id=${videoIds}&key=${apiKey}`),
      fetch(`https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelIds}&key=${apiKey}`)
    ]);
    const [videosData, channelsData] = await Promise.all([videosRes.json(), channelsRes.json()]);

    const videoMap = {};
    (videosData.items || []).forEach(v => { videoMap[v.id] = v; });
    const channelMap = {};
    (channelsData.items || []).forEach(c => { channelMap[c.id] = c; });

    const minSubsVal = parseInt(min_subs) || 0;
    const maxSubsVal = parseInt(max_subs) || 0;
    const minViewsVal = parseInt(min_views) || 0;
    const minDurSec = parseInt(min_dur) || 0;

    const result = items.map(item => {
      const vid = item.id?.videoId;
      if (!vid) return null;
      const snippet = item.snippet || {};
      const stats = videoMap[vid]?.statistics || {};
      const channelStats = channelMap[snippet.channelId]?.statistics || {};
      const { durationStr, totalSec, videoType } = parseDuration(videoMap[vid]?.contentDetails?.duration);
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
        subscribers: parseInt(channelStats.subscriberCount) || 0,
        duration: durationStr,
        totalSec, videoType,
        published: pub,
        publishedRaw: snippet.publishedAt || '',
      };
    }).filter(v => {
      if (!v) return false;
      if (minSubsVal && v.subscribers < minSubsVal) return false;
      if (maxSubsVal && v.subscribers > maxSubsVal) return false;
      if (minViewsVal && v.views < minViewsVal) return false;
      if (minDurSec && v.totalSec < minDurSec) return false;
      // Tipo de vídeo: filtro pós-busca para garantir
      if (video_type === 'short' && v.videoType !== 'short') return false;
      if (video_type === 'long' && v.videoType !== 'long') return false;
      if (video_type === 'video' && v.videoType === 'short') return false;
      return true;
    });

    // Ordena por score viral: ratio views/inscritos × velocidade × canal pequeno × frescor
    result.sort((a, b) => viralScore(b) - viralScore(a));

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
