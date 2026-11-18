const yts = require('yt-search');

function extractYouTubeId(inputUrl) {
  if (!inputUrl) return null;
  const match = inputUrl.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : (/^[a-zA-Z0-9_-]{11}$/.test(inputUrl) ? inputUrl : null);
}

async function fetchTimeout(url, options = {}, ms = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// 1. Direct InnerTube Android_VR / TV_Embedded Resolver (Bypasses Web Bot Checks)
async function resolveViaInnerTube(videoId, mode = 'video', quality = '720') {
  const qNum = parseInt(String(quality).replace(/\D/g, ''), 10) || 720;
  const clients = [
    {
      clientName: 'ANDROID_VR',
      clientVersion: '1.60.19',
      userAgent: 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
      osName: 'Android',
      osVersion: '12L',
      androidSdkVersion: 32
    },
    {
      clientName: 'IOS',
      clientVersion: '19.45.4',
      userAgent: 'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1 like Mac OS X;)',
      osName: 'iOS',
      osVersion: '18.1.0.22B83',
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2'
    }
  ];

  for (const c of clients) {
    try {
      const res = await fetchTimeout('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': c.userAgent,
          'X-YouTube-Client-Name': c.clientName === 'IOS' ? '5' : '28',
          'X-YouTube-Client-Version': c.clientVersion
        },
        body: JSON.stringify({
          videoId,
          context: {
            client: {
              clientName: c.clientName,
              clientVersion: c.clientVersion,
              osName: c.osName,
              osVersion: c.osVersion,
              ...(c.androidSdkVersion ? { androidSdkVersion: c.androidSdkVersion } : {}),
              ...(c.deviceMake ? { deviceMake: c.deviceMake, deviceModel: c.deviceModel } : {}),
              hl: 'en',
              gl: 'US'
            }
          },
          contentCheckOk: true,
          racyCheckOk: true
        })
      }, 4000);

      if (!res.ok) continue;
      const data = await res.json();
      const streamingData = data.streamingData;
      if (!streamingData) continue;

      const formats = [...(streamingData.formats || []), ...(streamingData.adaptiveFormats || [])].filter(f => f && f.url);
      if (formats.length === 0) continue;

      if (mode === 'audio') {
        const audios = formats
          .filter(f => (f.mimeType || '').startsWith('audio/'))
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        if (audios.length > 0) {
          return { url: audios[0].url, mime: (audios[0].mimeType || 'audio/mp4').split(';')[0] };
        }
      }

      const muxed = (streamingData.formats || []).filter(f => f && f.url);
      if (muxed.length > 0) {
        const matched = muxed.find(f => f.height === qNum || (f.qualityLabel || '').includes(String(qNum))) || muxed[muxed.length - 1];
        return { url: matched.url, mime: 'video/mp4' };
      }

      if (streamingData.hlsManifestUrl) {
        return { url: streamingData.hlsManifestUrl, mime: 'application/vnd.apple.mpegurl' };
      }
    } catch (_) {}
  }
  throw new Error('InnerTube unavailable');
}

// 2. Parallel Multi-Provider Resolver (InnerTube + Active Piped + Invidious + Cobalt)
async function resolveWorkingMedia(targetUrl, mode = 'video', quality = '720') {
  const videoId = extractYouTubeId(targetUrl);
  const qNum = parseInt(String(quality).replace(/\D/g, ''), 10) || 720;
  const tasks = [];

  if (videoId) {
    tasks.push(resolveViaInnerTube(videoId, mode, quality));

    const pipedNodes = [
      'https://pipedapi.kavin.rocks',
      'https://pipedapi.adminforge.de',
      'https://pipedapi.drgns.space',
      'https://api.piped.private.coffee'
    ];
    for (const node of pipedNodes) {
      tasks.push((async () => {
        const res = await fetchTimeout(`${node}/streams/${videoId}`, {}, 4000);
        if (!res.ok) throw new Error('Piped bad status');
        const data = await res.json();
        if (mode === 'audio' && Array.isArray(data.audioStreams) && data.audioStreams.length > 0) {
          const best = data.audioStreams.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
          if (best && best.url) return { url: best.url, mime: best.mimeType || 'audio/mp4' };
        }
        const videos = (data.videoStreams || []).filter(v => v.videoOnly === false);
        const pool = videos.length > 0 ? videos : (data.videoStreams || []);
        const match = pool.find(v => (v.quality || '').includes(String(qNum))) || pool[0];
        if (match && match.url) return { url: match.url, mime: 'video/mp4' };
        throw new Error('No Piped stream');
      })());
    }

    const invNodes = [
      'https://inv.nadeko.net',
      'https://invidious.nerdvpn.de',
      'https://iv.datura.network'
    ];
    for (const node of invNodes) {
      tasks.push((async () => {
        const res = await fetchTimeout(`${node}/api/v1/videos/${videoId}`, {}, 4000);
        if (!res.ok) throw new Error('Inv failed');
        const data = await res.json();
        if (mode === 'audio' && Array.isArray(data.adaptiveFormats)) {
          const aud = data.adaptiveFormats.filter(f => (f.type || '').startsWith('audio/')).sort((a, b) => (parseInt(b.bitrate || 0) - parseInt(a.bitrate || 0)))[0];
          if (aud && aud.itag) return { url: `${node}/latest_version?id=${videoId}&itag=${aud.itag}&local=true`, mime: 'audio/mp4' };
        }
        const fmt = (data.formatStreams || [])[0];
        if (fmt && fmt.itag) return { url: `${node}/latest_version?id=${videoId}&itag=${fmt.itag}&local=true`, mime: 'video/mp4' };
        throw new Error('No Inv format');
      })());
    }
  }

  const cobaltNodes = [
    'https://cobalt-backend.canine.tools',
    'https://cobalt-api.kwiatekmiki.com',
    'https://api.cobalt.best'
  ];
  for (const node of cobaltNodes) {
    tasks.push((async () => {
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
      if (!res.ok) throw new Error('Cobalt error');
      const data = await res.json();
      if (data && data.url) return { url: data.url, mime: mode === 'audio' ? 'audio/mpeg' : 'video/mp4' };
      throw new Error('No Cobalt url');
    })());
  }

  return await Promise.any(tasks);
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
    if (pathname === '/api/ping') {
      return res.status(200).json({ status: 'online', timestamp: Date.now() });
    }

    // SEARCH WITH CATEGORY FILTER (all, video, audio, podcast, radio)
    if (pathname === '/api/search') {
      const q = urlObj.searchParams.get('q');
      const filter = (urlObj.searchParams.get('filter') || 'all').toLowerCase();
      if (!q) return res.status(400).json({ error: 'Missing query' });

      if (filter === 'radio') {
        const radioRes = await fetchTimeout(`https://de1.api.radio-browser.info/json/stations/search?name=${encodeURIComponent(q)}&hidebroken=true&order=clickcount&reverse=true&limit=20`, {}, 4500);
        const stations = radioRes.ok ? await radioRes.json() : [];
        return res.status(200).json(stations.filter(s => s.url_resolved).map(s => ({
          id: s.stationuuid,
          title: s.name.trim(),
          uploader: s.country || s.tags || 'Live Radio',
          duration: 0,
          thumbnail: s.favicon || 'https://images.unsplash.com/photo-1598488035139-bdbb2231ce04?w=300&q=80',
          url: s.url_resolved,
          directStreamUrl: s.url_resolved,
          mediaType: 'audio',
          isLiveRadio: true
        })));
      }

      const effectiveQuery =
        filter === 'audio' ? `${q} official audio` :
        filter === 'podcast' ? `${q} full podcast episode` :
        q;

      const r = await yts(effectiveQuery);
      const items = (r.videos || []).slice(0, 22).map(v => {
        const lowerTitle = (v.title || '').toLowerCase();
        const inferredAudio = filter === 'audio' || filter === 'podcast' || lowerTitle.includes('audio') || lowerTitle.includes('lyrics') || lowerTitle.includes('topic');
        return {
          id: v.videoId,
          title: v.title,
          uploader: (v.author && v.author.name) ? v.author.name : 'Unknown',
          duration: v.seconds || 0,
          thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
          url: v.url || `https://www.youtube.com/watch?v=${v.videoId}`,
          mediaType: filter === 'video' ? 'video' : (inferredAudio ? 'audio' : 'video')
        };
      });
      return res.status(200).json(items);
    }

    if (pathname === '/api/related') {
      const title = urlObj.searchParams.get('title') || '';
      const uploader = urlObj.searchParams.get('uploader') || '';
      const currentId = urlObj.searchParams.get('id') || '';
      const cleanTitle = title.replace(/\(.*?\)|\[.*?\]/g, '').trim();
      const searchQuery = `${uploader} ${cleanTitle} mix`.trim() || 'top hits music';

      const r = await yts(searchQuery);
      const candidates = (r.videos || [])
        .filter(v => v.videoId !== currentId)
        .slice(0, 10)
        .map(v => ({
          id: v.videoId,
          title: v.title,
          uploader: (v.author && v.author.name) ? v.author.name : 'Unknown',
          duration: v.seconds || 0,
          thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
          url: v.url || `https://www.youtube.com/watch?v=${v.videoId}`,
          mediaType: 'audio'
        }));

      return res.status(200).json(candidates);
    }

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
          url: `https://www.youtube.com/watch?v=${videoId}`,
          mediaType: 'video'
        });
      }

      const oembedRes = await fetchTimeout(`https://noembed.com/embed?url=${encodeURIComponent(targetUrl)}`);
      const oembed = oembedRes.ok ? await oembedRes.json() : {};
      return res.status(200).json({
        id: String(Date.now()),
        title: oembed.title || 'Direct Media',
        uploader: oembed.author_name || oembed.provider_name || 'Web',
        duration: 0,
        thumbnail: oembed.thumbnail_url || '',
        url: targetUrl,
        mediaType: 'video'
      });
    }

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

    if (pathname === '/api/stream') {
      const targetUrl = urlObj.searchParams.get('url');
      const mode = urlObj.searchParams.get('mode') || 'video';
      const quality = urlObj.searchParams.get('quality') || '720';
      const startByte = parseInt(urlObj.searchParams.get('start') || '0', 10);
      const chunkSize = 2.5 * 1024 * 1024;

      const resolved = await resolveWorkingMedia(targetUrl, mode, quality);

      if (!urlObj.searchParams.has('chunked')) {
        return res.redirect(302, resolved.url);
      }

      const endByte = startByte + chunkSize - 1;
      const upstream = await fetch(resolved.url, {
        headers: {
          'Range': `bytes=${startByte}-${endByte}`,
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)'
        }
      });

      if (!upstream.ok && upstream.status !== 206) {
        throw new Error(`Upstream status ${upstream.status}`);
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
