const yts = require('yt-search');
const ytdl = require('@distube/ytdl-core');

function extractYouTubeId(inputUrl) {
  if (!inputUrl) return null;
  const match = inputUrl.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : (/^[a-zA-Z0-9_-]{11}$/.test(inputUrl) ? inputUrl : null);
}

async function fetchTimeout(url, options = {}, ms = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Fast parallel resolver across InnerTube, Invidious, Piped, and ytdl
async function resolveWorkingMedia(targetUrl, mode = 'video', quality = '720') {
  const videoId = extractYouTubeId(targetUrl);
  const qNum = parseInt(String(quality).replace(/\D/g, ''), 10) || 720;

  const resolvers = [];

  if (videoId) {
    // 1. Invidious Public API Nodes (Fast, provides proxied local streams that bypass IP locks)
    const invidiousNodes = [
      'https://inv.nadeko.net',
      'https://invidious.nerdvpn.de',
      'https://invidious.jing.rocks',
      'https://iv.datura.network'
    ];

    for (const node of invidiousNodes) {
      resolvers.push((async () => {
        const res = await fetchTimeout(`${node}/api/v1/videos/${videoId}`, {}, 4000);
        if (!res.ok) throw new Error('Invidious status ' + res.status);
        const data = await res.json();

        if (mode === 'audio' && Array.isArray(data.adaptiveFormats)) {
          const audios = data.adaptiveFormats
            .filter(f => (f.type || '').startsWith('audio/'))
            .sort((a, b) => (parseInt(b.bitrate || 0) - parseInt(a.bitrate || 0)));
          if (audios.length > 0 && audios[0].url) {
            return { url: `${node}/latest_version?id=${videoId}&itag=${audios[0].itag}&local=true`, mime: 'audio/mp4' };
          }
        }

        if (Array.isArray(data.formatStreams) && data.formatStreams.length > 0) {
          const matched = data.formatStreams.find(f => (f.qualityLabel || '').includes(String(qNum))) || data.formatStreams[0];
          if (matched) {
            return { url: `${node}/latest_version?id=${videoId}&itag=${matched.itag || 18}&local=true`, mime: 'video/mp4' };
          }
        }
        throw new Error('No formats in Invidious');
      })());
    }

    // 2. Piped Active API Nodes
    const pipedNodes = [
      'https://pipedapi.kavin.rocks',
      'https://pipedapi.adminforge.de',
      'https://api.piped.private.coffee'
    ];

    for (const node of pipedNodes) {
      resolvers.push((async () => {
        const res = await fetchTimeout(`${node}/streams/${videoId}`, {}, 4000);
        if (!res.ok) throw new Error('Piped failed');
        const data = await res.json();
        if (mode === 'audio' && Array.isArray(data.audioStreams) && data.audioStreams.length > 0) {
          const best = data.audioStreams.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
          if (best && best.url) return { url: best.url, mime: best.mimeType || 'audio/mp4' };
        }
        if (Array.isArray(data.videoStreams) && data.videoStreams.length > 0) {
          const progressive = data.videoStreams.filter(s => s.videoOnly === false);
          const list = progressive.length > 0 ? progressive : data.videoStreams;
          const match = list.find(s => (s.quality || '').includes(String(qNum))) || list[0];
          if (match && match.url) return { url: match.url, mime: 'video/mp4' };
        }
        throw new Error('No Piped stream');
      })());
    }

    // 3. @distube/ytdl-core fallback
    resolvers.push((async () => {
      const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`);
      if (mode === 'audio') {
        const fmt = ytdl.chooseFormat(info.formats, { quality: 'highestaudio' });
        if (fmt && fmt.url) return { url: fmt.url, mime: 'audio/mp4' };
      }
      const progressive = info.formats.filter(f => f.hasVideo && f.hasAudio);
      const fmt = progressive.find(f => f.height === qNum) || progressive[0] || ytdl.chooseFormat(info.formats, { quality: 'highest' });
      if (fmt && fmt.url) return { url: fmt.url, mime: 'video/mp4' };
      throw new Error('No ytdl format');
    })());
  }

  // 4. Multi-platform resolver (TikTok, SoundCloud, Instagram, X, YouTube)
  const cobaltNodes = [
    'https://cobalt-backend.canine.tools',
    'https://cobalt-api.kwiatekmiki.com'
  ];
  for (const node of cobaltNodes) {
    resolvers.push((async () => {
      const res = await fetchTimeout(`${node}/`, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: targetUrl,
          videoQuality: String(qNum),
          audioFormat: 'mp3',
          downloadMode: mode === 'audio' ? 'audio' : 'auto'
        })
      }, 4500);
      if (!res.ok) throw new Error('Cobalt failed');
      const data = await res.json();
      if (data && data.url) {
        return { url: data.url, mime: mode === 'audio' ? 'audio/mpeg' : 'video/mp4' };
      }
      throw new Error('No Cobalt URL');
    })());
  }

  return await Promise.any(resolvers);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const urlObj = new URL(req.url, `https://${req.headers.host}`);
  const pathname = urlObj.pathname;

  try {
    // 1. PING
    if (pathname === '/api/ping') {
      return res.status(200).json({ status: 'online', timestamp: Date.now() });
    }

    // 2. SEARCH
    if (pathname === '/api/search') {
      const q = urlObj.searchParams.get('q');
      if (!q) return res.status(400).json({ error: 'Missing query' });

      const r = await yts(q);
      const items = (r.videos || []).slice(0, 20).map(v => ({
        id: v.videoId,
        title: v.title,
        uploader: (v.author && v.author.name) ? v.author.name : 'Unknown',
        duration: v.seconds || 0,
        thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
        url: v.url || `https://www.youtube.com/watch?v=${v.videoId}`
      }));
      return res.status(200).json(items);
    }

    // 3. RELATED TRACKS (For Auto-Play Related Media after Queue ends)
    if (pathname === '/api/related') {
      const title = urlObj.searchParams.get('title') || '';
      const uploader = urlObj.searchParams.get('uploader') || '';
      const currentId = urlObj.searchParams.get('id') || '';
      const searchQuery = `${uploader} ${title}`.trim() || 'popular music';

      const r = await yts(searchQuery);
      const candidates = (r.videos || [])
        .filter(v => v.videoId !== currentId)
        .slice(0, 8)
        .map(v => ({
          id: v.videoId,
          title: v.title,
          uploader: (v.author && v.author.name) ? v.author.name : 'Unknown',
          duration: v.seconds || 0,
          thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
          url: v.url || `https://www.youtube.com/watch?v=${v.videoId}`
        }));

      return res.status(200).json(candidates);
    }

    // 4. DIRECT URL INFO
    if (pathname === '/api/info') {
      const targetUrl = urlObj.searchParams.get('url');
      if (!targetUrl) return res.status(400).json({ error: 'Missing url' });

      const videoId = extractYouTubeId(targetUrl);
      if (videoId) {
        const v = await yts({ videoId });
        return res.status(200).json({
          id: v.videoId || videoId,
          title: v.title || 'Media',
          uploader: (v.author && v.author.name) ? v.author.name : 'YouTube',
          duration: v.seconds || 0,
          thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          url: `https://www.youtube.com/watch?v=${videoId}`
        });
      }

      const oembedRes = await fetchTimeout(`https://noembed.com/embed?url=${encodeURIComponent(targetUrl)}`);
      const oembed = oembedRes.ok ? await oembedRes.json() : {};
      return res.status(200).json({
        id: String(Date.now()),
        title: oembed.title || 'Media Link',
        uploader: oembed.author_name || oembed.provider_name || 'Web',
        duration: 0,
        thumbnail: oembed.thumbnail_url || '',
        url: targetUrl
      });
    }

    // 5. RESOLVE STREAM
    if (pathname === '/api/resolve-stream') {
      const targetUrl = urlObj.searchParams.get('url');
      const mode = urlObj.searchParams.get('mode') || 'video';
      const quality = urlObj.searchParams.get('quality') || '720';
      const resolved = await resolveWorkingMedia(targetUrl, mode, quality);
      return res.status(200).json({
        directUrl: resolved.url,
        mime: resolved.mime,
        proxyUrl: `https://${req.headers.host}/api/stream?url=${encodeURIComponent(targetUrl)}&mode=${mode}&quality=${quality}`
      });
    }

    // 6. STREAM & CHUNKED DOWNLOAD PROXY
    if (pathname === '/api/stream') {
      const targetUrl = urlObj.searchParams.get('url');
      const mode = urlObj.searchParams.get('mode') || 'video';
      const quality = urlObj.searchParams.get('quality') || '720';
      const startByte = parseInt(urlObj.searchParams.get('start') || '0', 10);
      const chunkSize = 2.5 * 1024 * 1024; // 2.5 MB safe chunk under Vercel 4.5MB limit

      const resolved = await resolveWorkingMedia(targetUrl, mode, quality);

      if (!urlObj.searchParams.has('chunked')) {
        return res.redirect(302, resolved.url);
      }

      const endByte = startByte + chunkSize - 1;
      const upstream = await fetch(resolved.url, {
        headers: {
          'Range': `bytes=${startByte}-${endByte}`,
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'
        }
      });

      if (!upstream.ok && upstream.status !== 206) {
        throw new Error(`Upstream HTTP ${upstream.status}`);
      }

      const contentRange = upstream.headers.get('content-range');
      if (contentRange) res.setHeader('Content-Range', contentRange);
      res.setHeader('Content-Type', resolved.mime || (mode === 'audio' ? 'audio/mp4' : 'video/mp4'));
      res.setHeader('Accept-Ranges', 'bytes');

      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader('Content-Length', buf.length);
      return res.status(upstream.status === 206 ? 206 : 200).send(buf);
    }

    return res.status(200).json({ status: 'ready' });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Resolution failed' });
  }
};
