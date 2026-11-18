const yts = require('yt-search');
const ytdl = require('@distube/ytdl-core');

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.tokhmi.xyz',
  'https://pipedapi.moomoo.me',
  'https://pipedapi-libre.kavin.rocks'
];

const COBALT_INSTANCES = [
  'https://cobalt-api.kwiatekmiki.com',
  'https://cobalt.api.timelessnesses.me'
];

async function fetchWithTimeout(url, options = {}, timeoutMs = 7000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

function extractYouTubeId(inputUrl) {
  const match = inputUrl.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

async function resolveDirectStreamUrl(targetUrl, mode, quality) {
  // 1. Try Cobalt API instances first (works for YouTube, TikTok, Instagram, SoundCloud, X)
  for (const instance of COBALT_INSTANCES) {
    try {
      const res = await fetchWithTimeout(`${instance}/`, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          url: targetUrl,
          videoQuality: String(quality || '720'),
          audioFormat: 'mp3',
          downloadMode: mode === 'audio' ? 'audio' : 'auto'
        })
      }, 6000);
      if (res.ok) {
        const data = await res.json();
        if (data && data.url) return data.url;
      }
    } catch (_) {}
  }

  // 2. Fallback to Piped Streams API for YouTube URLs
  const videoId = extractYouTubeId(targetUrl);
  if (videoId) {
    for (const piped of PIPED_INSTANCES) {
      try {
        const res = await fetchWithTimeout(`${piped}/streams/${videoId}`, {}, 6000);
        if (res.ok) {
          const data = await res.json();
          if (mode === 'audio' && Array.isArray(data.audioStreams) && data.audioStreams.length > 0) {
            const sortedAudio = data.audioStreams.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
            return sortedAudio[0].url;
          }
          if (Array.isArray(data.videoStreams) && data.videoStreams.length > 0) {
            const withAudio = data.videoStreams.filter(s => s.videoOnly === false);
            const pool = withAudio.length > 0 ? withAudio : data.videoStreams;
            const matched = pool.find(s => (s.quality || '').includes(String(quality))) || pool[0];
            if (matched && matched.url) return matched.url;
          }
        }
      } catch (_) {}
    }

    // 3. Fallback to @distube/ytdl-core
    const info = await ytdl.getInfo(targetUrl);
    if (mode === 'audio') {
      const format = ytdl.chooseFormat(info.formats, { quality: 'highestaudio' });
      if (format && format.url) return format.url;
    } else {
      const formats = info.formats.filter(f => f.hasVideo && f.hasAudio && f.container === 'mp4');
      const matched = formats.find(f => String(f.height) === String(quality)) || formats[0] || ytdl.chooseFormat(info.formats, { quality: 'highest' });
      if (matched && matched.url) return matched.url;
    }
  }

  throw new Error('Could not resolve direct media stream from upstream providers.');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const urlObj = new URL(req.url, `https://${req.headers.host}`);
  const pathname = urlObj.pathname;

  try {
    // 1. PING ENDPOINT
    if (pathname === '/api/ping') {
      return res.status(200).json({
        status: 'online',
        server: 'Vercel Serverless Engine',
        timestamp: Date.now()
      });
    }

    // 2. SEARCH ENDPOINT
    if (pathname === '/api/search') {
      const q = urlObj.searchParams.get('q');
      if (!q) return res.status(400).json({ error: 'Missing search query parameter q' });

      const searchResult = await yts(q);
      const videos = (searchResult.videos || []).slice(0, 18).map(v => ({
        id: v.videoId,
        title: v.title,
        uploader: (v.author && v.author.name) ? v.author.name : 'Unknown Artist',
        duration: v.seconds || 0,
        thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
        url: v.url || `https://www.youtube.com/watch?v=${v.videoId}`
      }));

      return res.status(200).json(videos);
    }

    // 3. INFO / LINK RESOLVER ENDPOINT
    if (pathname === '/api/info') {
      const targetUrl = urlObj.searchParams.get('url');
      if (!targetUrl) return res.status(400).json({ error: 'Missing url parameter' });

      const videoId = extractYouTubeId(targetUrl);
      if (videoId) {
        const video = await yts({ videoId });
        return res.status(200).json({
          id: video.videoId || videoId,
          title: video.title || 'Resolved Media',
          uploader: (video.author && video.author.name) ? video.author.name : 'YouTube',
          duration: video.seconds || 0,
          thumbnail: video.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          url: targetUrl
        });
      }

      // Non-YouTube URLs (TikTok, SoundCloud, Instagram, X) via noembed oEmbed
      const oembedRes = await fetchWithTimeout(`https://noembed.com/embed?url=${encodeURIComponent(targetUrl)}`);
      const oembed = oembedRes.ok ? await oembedRes.json() : {};
      return res.status(200).json({
        id: String(Date.now()),
        title: oembed.title || targetUrl.split('/').pop() || 'External Platform Media',
        uploader: oembed.author_name || oembed.provider_name || 'Direct Link',
        duration: 0,
        thumbnail: oembed.thumbnail_url || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=600&q=80',
        url: targetUrl
      });
    }

    // 4.RESOLVE DIRECT STREAM URL ENDPOINT
    if (pathname === '/api/resolve-stream') {
      const targetUrl = urlObj.searchParams.get('url');
      const mode = urlObj.searchParams.get('mode') || 'video';
      const quality = urlObj.searchParams.get('quality') || '720';
      if (!targetUrl) return res.status(400).json({ error: 'Missing url parameter' });

      const directUrl = await resolveDirectStreamUrl(targetUrl, mode, quality);
      return res.status(200).json({
        directUrl,
        proxyUrl: `https://${req.headers.host}/api/stream?url=${encodeURIComponent(targetUrl)}&mode=${mode}&quality=${quality}`
      });
    }

    // 5. CHUNK-SAFE STREAM & PROXY ENDPOINT (Bypasses Vercel 4.5MB limit via Range headers)
    if (pathname === '/api/stream') {
      const targetUrl = urlObj.searchParams.get('url');
      const mode = urlObj.searchParams.get('mode') || 'video';
      const quality = urlObj.searchParams.get('quality') || '720';
      const startByte = parseInt(urlObj.searchParams.get('start') || '0', 10);
      const chunkSize = 3 * 1024 * 1024; // 3 MB safe chunk size under Vercel 4.5 MB limit

      if (!targetUrl) return res.status(400).json({ error: 'Missing url parameter' });

      const directUrl = await resolveDirectStreamUrl(targetUrl, mode, quality);

      // If browser/player requests directly without chunking parameter, redirect to the signed CDN stream
      if (!urlObj.searchParams.has('chunked')) {
        return res.redirect(302, directUrl);
      }

      const endByte = startByte + chunkSize - 1;
      const upstream = await fetch(directUrl, {
        headers: {
          'Range': `bytes=${startByte}-${endByte}`,
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'
        }
      });

      const contentRange = upstream.headers.get('content-range');
      const contentType = upstream.headers.get('content-type') || (mode === 'audio' ? 'audio/mp4' : 'video/mp4');

      if (contentRange) res.setHeader('Content-Range', contentRange);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Accept-Ranges', 'bytes');

      const arrayBuffer = await upstream.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      res.setHeader('Content-Length', buffer.length);
      return res.status(upstream.status === 206 ? 206 : 200).send(buffer);
    }

    return res.status(200).json({
      service: 'TubidyFM Vercel API',
      status: 'ready',
      endpoints: ['/api/ping', '/api/search?q=', '/api/info?url=', '/api/resolve-stream', '/api/stream']
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
};
