const yts = require('yt-search');
const ytdl = require('@distube/ytdl-core');

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.tokhmi.xyz',
  'https://pipedapi.moomoo.me',
  'https://pipedapi-libre.kavin.rocks'
];

const COBALT_INSTANCES = [
  'https://cobalt.aelew.dev',
  'https://cobalt-api.kwiatekmiki.com'
];

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(id);
  }
}

async function extractMediaStreams(targetUrl) {
  // 1. Try @distube/ytdl-core for YouTube URLs
  if (ytdl.validateURL(targetUrl)) {
    try {
      const info = await ytdl.getInfo(targetUrl);
      const videoFormats = info.formats.filter(f => f.hasVideo && f.hasAudio && f.container === 'mp4');
      const audioFormats = info.formats.filter(f => !f.hasVideo && f.hasAudio);
      return {
        id: info.videoDetails.videoId,
        title: info.videoDetails.title,
        uploader: info.videoDetails.author?.name || 'YouTube',
        duration: Number(info.videoDetails.lengthSeconds || 0),
        thumbnail: info.videoDetails.thumbnails?.slice(-1)[0]?.url || '',
        url: targetUrl,
        streams: {
          '1080': (videoFormats.find(f => f.height === 1080) || videoFormats[0])?.url,
          '720': (videoFormats.find(f => f.height === 720) || videoFormats[0])?.url,
          '480': (videoFormats.find(f => f.height === 480) || videoFormats[0])?.url,
          '360': (videoFormats.find(f => f.height === 360) || videoFormats[videoFormats.length - 1])?.url,
          'audio': (audioFormats.find(f => f.container === 'm4a') || audioFormats[0] || videoFormats[0])?.url
        }
      };
    } catch (e) {
      // Fall through to Piped / Cobalt fallback if datacenter IP is rate-limited
    }

    // 2. Fallback to Piped public nodes for YouTube video IDs
    const videoId = ytdl.getURLVideoID(targetUrl);
    for (const host of PIPED_INSTANCES) {
      try {
        const data = await fetchJsonWithTimeout(`${host}/streams/${videoId}`);
        const vStreams = (data.videoStreams || []).filter(s => !s.videoOnly);
        const aStreams = data.audioStreams || [];
        if (vStreams.length || aStreams.length) {
          return {
            id: videoId,
            title: data.title || 'Media Stream',
            uploader: data.uploader || 'YouTube',
            duration: data.duration || 0,
            thumbnail: data.thumbnailUrl || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
            url: targetUrl,
            streams: {
              '1080': (vStreams.find(s => s.quality === '1080p') || vStreams[0])?.url,
              '720': (vStreams.find(s => s.quality === '720p') || vStreams[0])?.url,
              '480': (vStreams.find(s => s.quality === '480p') || vStreams[0])?.url,
              '360': (vStreams.find(s => s.quality === '360p') || vStreams[vStreams.length - 1])?.url,
              'audio': (aStreams.find(s => s.mimeType?.includes('mp4')) || aStreams[0] || vStreams[0])?.url
            }
          };
        }
      } catch {}
    }
  }

  // 3. Multi-platform fallback (TikTok, SoundCloud, Instagram, X, YouTube) via Cobalt API
  for (const instance of COBALT_INSTANCES) {
    try {
      const vData = await fetchJsonWithTimeout(instance, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl, videoQuality: '720', downloadMode: 'auto' })
      });
      const aData = await fetchJsonWithTimeout(instance, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl, downloadMode: 'audio', audioFormat: 'mp3' })
      }).catch(() => null);

      if (vData && vData.url) {
        return {
          id: String(Date.now()),
          title: vData.filename || 'Direct Media Stream',
          uploader: new URL(targetUrl).hostname.replace('www.', ''),
          duration: 0,
          thumbnail: '',
          url: targetUrl,
          streams: {
            '1080': vData.url,
            '720': vData.url,
            '480': vData.url,
            '360': vData.url,
            'audio': aData?.url || vData.url
          }
        };
      }
    } catch {}
  }

  // 4. Direct MP4/MP3 URL passthrough
  return {
    id: String(Date.now()),
    title: targetUrl.split('/').pop()?.split('?')[0] || 'Direct Media',
    uploader: 'Direct Link',
    duration: 0,
    thumbnail: '',
    url: targetUrl,
    streams: { '1080': targetUrl, '720': targetUrl, '480': targetUrl, '360': targetUrl, 'audio': targetUrl }
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const path = req.url.split('?')[0];

  // Endpoint 1: Health check
  if (path.endsWith('/ping')) {
    return res.status(200).json({ status: 'online', engine: 'Vercel Serverless 24/7', timestamp: Date.now() });
  }

  // Endpoint 2: Search
  if (path.endsWith('/search')) {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'Missing query parameter q' });
    try {
      const r = await yts(q);
      const videos = (r.videos || []).slice(0, 15).map(v => ({
        id: v.videoId,
        title: v.title,
        uploader: v.author?.name || 'Unknown',
        duration: v.seconds || 0,
        thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
        url: v.url
      }));
      return res.status(200).json(videos);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Endpoint 3: Info & Direct Stream URLs
  if (path.endsWith('/info')) {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: 'Missing url parameter' });
    try {
      const info = await extractMediaStreams(targetUrl);
      return res.status(200).json(info);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Endpoint 4: Stream Redirect / CORS Proxy
  if (path.endsWith('/stream')) {
    const { url, mode = 'video', quality = '720', proxy = '0' } = req.query;
    if (!url) return res.status(400).send('Missing url');
    try {
      const info = await extractMediaStreams(url);
      const targetStreamUrl = mode === 'audio'
        ? (info.streams['audio'] || info.streams['360'])
        : (info.streams[quality] || info.streams['720'] || info.streams['360']);

      if (!targetStreamUrl) return res.status(404).json({ error: 'No stream found' });

      if (proxy === '1') {
        const upstream = await fetch(targetStreamUrl, {
          headers: req.headers.range ? { Range: req.headers.range } : {}
        });
        res.status(upstream.status);
        upstream.headers.forEach((val, key) => {
          if (['content-type', 'content-length', 'content-range', 'accept-ranges'].includes(key.toLowerCase())) {
            res.setHeader(key, val);
          }
        });
        const arrayBuffer = await upstream.arrayBuffer();
        return res.send(Buffer.from(arrayBuffer));
      }

      // Redirect directly so the iPhone downloads from the CDN without burning cloud CPU
      return res.redirect(302, targetStreamUrl);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(200).json({ status: 'ready' });
};
