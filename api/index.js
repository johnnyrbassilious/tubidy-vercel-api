const yts = require('yt-search');

function extractYouTubeId(inputUrl) {
  if (!inputUrl) return null;
  const match = inputUrl.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : (/^[a-zA-Z0-9_-]{11}$/.test(inputUrl) ? inputUrl : null);
}

async function fetchTimeout(url, options = {}, ms = 6500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeTitle(str = '') {
  return str
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/official|video|audio|lyrics|lyric|hd|4k|remastered|mv|visualizer/gi, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function parseDurationToSeconds(text = '') {
  const parts = String(text).trim().split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

function deduplicateItems(items) {
  const seenIds = new Set();
  const seenKeys = new Set();
  const out = [];

  for (const item of items) {
    if (!item || !item.id || seenIds.has(item.id)) continue;
    const normTitle = normalizeTitle(item.title);
    const normArtist = normalizeTitle(item.uploader);
    const key = `${normTitle}::${normArtist}`;
    if (normTitle && seenKeys.has(key)) continue;

    seenIds.add(item.id);
    if (normTitle) seenKeys.add(key);
    out.push(item);
  }
  return out;
}

// YouTube Music WEB_REMIX Search (strictly separates Songs vs Videos without overwriting titles/art)
async function searchYouTubeMusic(query, params) {
  const res = await fetchTimeout('https://music.youtube.com/youtubei/v1/search?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Origin': 'https://music.youtube.com',
      'Referer': 'https://music.youtube.com/'
    },
    body: JSON.stringify({
      query,
      params,
      context: {
        client: {
          clientName: 'WEB_REMIX',
          clientVersion: '1.20260901.01.00',
          hl: 'en',
          gl: 'US'
        }
      }
    })
  }, 4500);

  if (!res.ok) return [];
  const data = await res.json();
  const items = [];

  const tabs = data?.contents?.tabbedSearchResultsRenderer?.tabs || [];
  const sections = tabs[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];

  for (const sec of sections) {
    const shelfItems = sec?.musicShelfRenderer?.contents || [];
    for (const entry of shelfItems) {
      const r = entry?.musicResponsiveListItemRenderer;
      if (!r) continue;

      const videoId =
        r?.playlistItemData?.videoId ||
        r?.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
      if (!videoId) continue;

      const flexCols = r.flexColumns || [];
      const title =
        flexCols[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.map(x => x.text).join('') || '';
      const subRuns =
        flexCols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
      const subTexts = subRuns.map(x => x.text).filter(t => t && t.trim() !== '•' && t.trim() !== '&');

      const durationText = subTexts.find(t => /^\d+:\d+(:\d+)?$/.test(t.trim())) || '';
      const uploader = subTexts.find(t => !/^\d+:\d+/.test(t.trim()) && !/plays|views|song|video/i.test(t)) || 'YouTube Music';
      const thumbs = r?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
      const thumb = thumbs.length ? thumbs[thumbs.length - 1].url : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

      if (title) {
        items.push({
          id: videoId,
          title: title.trim(),
          uploader: uploader.replace(' - Topic', '').trim(),
          duration: parseDurationToSeconds(durationText),
          thumbnail: thumb,
          url: `https://www.youtube.com/watch?v=${videoId}`
        });
      }
    }
  }
  return items;
}

// YouTube Music Real Radio / Up Next Engine (RDAMVM{videoId})
async function fetchYTMusicRadio(videoId) {
  const res = await fetchTimeout('https://music.youtube.com/youtubei/v1/next?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Origin': 'https://music.youtube.com'
    },
    body: JSON.stringify({
      videoId,
      playlistId: `RDAMVM${videoId}`,
      isAudioOnly: true,
      context: {
        client: {
          clientName: 'WEB_REMIX',
          clientVersion: '1.20260901.01.00',
          hl: 'en',
          gl: 'US'
        }
      }
    })
  }, 4500);

  if (!res.ok) return [];
  const data = await res.json();
  const queueContents =
    data?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer
      ?.tabs?.[0]?.tabRenderer?.content?.musicQueueRenderer?.content?.playlistPanelRenderer?.contents || [];

  const results = [];
  for (const row of queueContents) {
    const r = row?.playlistPanelVideoRenderer;
    if (!r || !r.videoId || r.videoId === videoId) continue;

    const title = r?.title?.runs?.map(x => x.text).join('') || '';
    const artist = r?.longBylineText?.runs?.[0]?.text || r?.shortBylineText?.runs?.[0]?.text || 'YouTube Music';
    const durText = r?.lengthText?.runs?.[0]?.text || '';
    const thumbs = r?.thumbnail?.thumbnails || [];
    const thumb = thumbs.length ? thumbs[thumbs.length - 1].url : `https://i.ytimg.com/vi/${r.videoId}/hqdefault.jpg`;

    if (title) {
      results.push({
        id: r.videoId,
        title: title.trim(),
        uploader: artist.replace(' - Topic', '').trim(),
        duration: parseDurationToSeconds(durText),
        thumbnail: thumb,
        url: `https://www.youtube.com/watch?v=${r.videoId}`,
        mediaType: 'audio',
        platform: 'YT Music'
      });
    }
  }
  return results;
}

// Direct Media Resolver (handles direct audio/video URLs & live radio streams)
async function resolveWorkingMedia(targetUrl, mode = 'audio') {
  if (!targetUrl) {
    throw new Error('Missing url parameter');
  }

  const videoId = extractYouTubeId(targetUrl);

  // Direct audio/video files (e.g., Radio streams or direct MP3/MP4 links)
  if (!videoId && /^https?:\/\//i.test(targetUrl)) {
    return {
      url: targetUrl,
      mime: mode === 'audio' ? 'audio/mpeg' : 'video/mp4'
    };
  }

  if (videoId) {
    throw new Error(`Direct stream extraction is unavailable for YouTube ID ${videoId}. Use /api/embed?id=${videoId} for playback.`);
  }

  throw new Error('Unsupported media URL');
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

    // OFFICIAL YOUTUBE EMBED BRIDGE (Fixes iOS Capacitor Error 153 + syncs player controls)
    if (pathname === '/api/embed') {
      const id = extractYouTubeId(urlObj.searchParams.get('id') || urlObj.searchParams.get('url'));
      if (!id) return res.status(400).send('Missing video id');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(`<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <style>
    html, body, #player { margin: 0; padding: 0; width: 100%; height: 100%; background: #000; border: 0; overflow: hidden; }
  </style>
</head>
<body>
  <div id="player"></div>
  <script src="https://www.youtube.com/iframe_api"></script>
  <script>
    var player = null;
    var pollTimer = null;
    var videoId = ${JSON.stringify(id)};

    function notify(type, payload) {
      try {
        window.parent.postMessage(Object.assign({ source: 'jtunes-yt', type: type }, payload || {}), '*');
      } catch (e) {}
    }

    function onYouTubeIframeAPIReady() {
      player = new YT.Player('player', {
        videoId: videoId,
        width: '100%',
        height: '100%',
        playerVars: {
          autoplay: 1,
          controls: 0,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          enablejsapi: 1,
          origin: window.location.origin
        },
        events: {
          onReady: function(ev) {
            var dur = ev.target.getDuration();
            notify('ready', { duration: isFinite(dur) ? dur : 0 });
            ev.target.playVideo();
            pollTimer = setInterval(function() {
              if (!player || !player.getCurrentTime) return;
              try {
                var t = player.getCurrentTime();
                var d = player.getDuration();
                if (isFinite(t) && isFinite(d)) {
                  notify('time', { currentTime: t, duration: d });
                }
              } catch (e) {}
            }, 500);
          },
          onStateChange: function(ev) {
            notify('state', { state: ev.data });
          },
          onError: function(ev) {
            notify('error', { code: typeof ev.data === 'number' ? ev.data : 0 });
          }
        }
      });
    }

    window.addEventListener('message', function(event) {
      var msg = event.data;
      if (!msg || msg.source !== 'jtunes-app' || !player) return;
      try {
        if (msg.cmd === 'play') player.playVideo();
        else if (msg.cmd === 'pause') player.pauseVideo();
        else if (msg.cmd === 'seekTo') player.seekTo(Number(msg.seconds) || 0, true);
        else if (msg.cmd === 'setPlaybackRate') player.setPlaybackRate(Number(msg.rate) || 1);
        else if (msg.cmd === 'setPlaybackQuality' && player.setPlaybackQuality) player.setPlaybackQuality(msg.quality);
      } catch (e) {}
    });
  </script>
</body>
</html>`);
    }

    // 1. AUTOCOMPLETE & TYPO SUGGESTIONS
    if (pathname === '/api/suggestions') {
      const q = (urlObj.searchParams.get('q') || '').trim();
      if (!q) return res.status(200).json([]);

      try {
        const sugRes = await fetchTimeout(
          `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(q)}`,
          {},
          2500
        );
        if (sugRes.ok) {
          const data = await sugRes.json();
          if (Array.isArray(data[1])) {
            return res.status(200).json(data[1].slice(0, 8));
          }
        }
      } catch (_) {}
      return res.status(200).json([]);
    }

    // 2. ACCURATE PLATFORM-SEPARATED SEARCH (ZERO TITLE OVERWRITING, DEDUPLICATED)
    if (pathname === '/api/search') {
      const q = (urlObj.searchParams.get('q') || '').trim();
      const filter = (urlObj.searchParams.get('filter') || 'all').toLowerCase();
      if (!q) return res.status(400).json({ error: 'Missing query' });

      let correctedQuery = q;
      try {
        const sugRes = await fetchTimeout(
          `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(q)}`,
          {},
          2000
        );
        if (sugRes.ok) {
          const sugData = await sugRes.json();
          if (Array.isArray(sugData[1]) && sugData[1].length > 0) {
            correctedQuery = sugData[1][0];
          }
        }
      } catch (_) {}

      // A) LIVE RADIO STATIONS
      if (filter === 'radio') {
        const radioRes = await fetchTimeout(
          `https://de1.api.radio-browser.info/json/stations/search?name=${encodeURIComponent(q)}&hidebroken=true&order=clickcount&reverse=true&limit=20`,
          {},
          4500
        );
        const stations = radioRes.ok ? await radioRes.json() : [];
        return res.status(200).json(
          stations.filter(s => s.url_resolved).map(s => ({
            id: s.stationuuid,
            title: s.name.trim(),
            uploader: `${s.country || 'Live'} • Radio`,
            duration: 0,
            thumbnail: s.favicon || 'https://images.unsplash.com/photo-1598488035139-bdbb2231ce04?w=300&q=80',
            url: s.url_resolved,
            directStreamUrl: s.url_resolved,
            mediaType: 'audio',
            platform: 'Radio',
            isLiveRadio: true
          }))
        );
      }

      // B) STRICT AUDIO FILTER (YouTube Music Songs catalog only — exact titles & art)
      if (filter === 'audio') {
        let songs = await searchYouTubeMusic(q, 'EgWKAQIIAWoMEA4QChADEAQQCRAF').catch(() => []);
        if (songs.length === 0 && correctedQuery !== q) {
          songs = await searchYouTubeMusic(correctedQuery, 'EgWKAQIIAWoMEA4QChADEAQQCRAF').catch(() => []);
        }
        if (songs.length === 0) {
          const r = await yts(`${q} official audio`);
          songs = (r.videos || []).map(v => ({
            id: v.videoId,
            title: v.title.replace(/\(Official Audio\)|\[Official Audio\]/gi, '').trim(),
            uploader: (v.author?.name || 'YT Music').replace(' - Topic', '').trim(),
            duration: v.seconds || 0,
            thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
            url: v.url || `https://www.youtube.com/watch?v=${v.videoId}`
          }));
        }
        const cleaned = deduplicateItems(songs.map(s => ({ ...s, mediaType: 'audio', platform: 'YT Music' })));
        return res.status(200).json(cleaned.slice(0, 20));
      }

      // C) STRICT VIDEO FILTER (YouTube Music Videos / YouTube MP4 uploads only)
      if (filter === 'video') {
        let vids = await searchYouTubeMusic(q, 'EgWKAQIQAWoMEA4QChADEAQQCRAF').catch(() => []);
        if (vids.length === 0) {
          const r = await yts(q);
          vids = (r.videos || [])
            .filter(v => !((v.author?.name) || '').endsWith('- Topic'))
            .map(v => ({
              id: v.videoId,
              title: v.title,
              uploader: v.author?.name || 'YouTube',
              duration: v.seconds || 0,
              thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
              url: v.url || `https://www.youtube.com/watch?v=${v.videoId}`
            }));
        }
        const cleaned = deduplicateItems(vids.map(v => ({ ...v, mediaType: 'video', platform: 'YouTube' })));
        return res.status(200).json(cleaned.slice(0, 20));
      }

      // D) PODCAST FILTER
      if (filter === 'podcast') {
        let r = await yts(`${q} podcast episode`);
        if (!r.videos || r.videos.length === 0) r = await yts(`${correctedQuery} podcast`);
        const podResults = (r.videos || []).map(v => ({
          id: v.videoId,
          title: v.title,
          uploader: v.author?.name || 'Podcast',
          duration: v.seconds || 0,
          thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
          url: v.url || `https://www.youtube.com/watch?v=${v.videoId}`,
          mediaType: 'audio',
          platform: 'Podcast'
        }));
        return res.status(200).json(deduplicateItems(podResults).slice(0, 20));
      }

      // E) "ALL" FILTER (Interleaves genuine YT Music Audio + genuine YouTube Videos)
      const [songs, ytVids] = await Promise.all([
        searchYouTubeMusic(q, 'EgWKAQIIAWoMEA4QChADEAQQCRAF').catch(() => []),
        searchYouTubeMusic(q, 'EgWKAQIQAWoMEA4QChADEAQQCRAF').catch(() => [])
      ]);

      const combined = [];
      for (let i = 0; i < Math.max(songs.length, ytVids.length); i++) {
        if (songs[i]) combined.push({ ...songs[i], mediaType: 'audio', platform: 'YT Music' });
        if (ytVids[i]) combined.push({ ...ytVids[i], mediaType: 'video', platform: 'YouTube' });
      }

      if (combined.length === 0) {
        const fallback = await yts(correctedQuery);
        for (const v of (fallback.videos || []).slice(0, 20)) {
          const isAudio = (v.author?.name || '').endsWith('- Topic');
          combined.push({
            id: v.videoId,
            title: v.title,
            uploader: (v.author?.name || 'YouTube').replace(' - Topic', ''),
            duration: v.seconds || 0,
            thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
            url: v.url || `https://www.youtube.com/watch?v=${v.videoId}`,
            mediaType: isAudio ? 'audio' : 'video',
            platform: isAudio ? 'YT Music' : 'YouTube'
          });
        }
      }

      return res.status(200).json(deduplicateItems(combined).slice(0, 24));
    }

    // 3. REAL YOUTUBE MUSIC RADIO AUTOPLAY (RDAMVM recommendation graph + Listening History)
    if (pathname === '/api/related') {
      const title = urlObj.searchParams.get('title') || '';
      const uploader = (urlObj.searchParams.get('uploader') || '').replace(' - Topic', '').trim();
      const currentId = urlObj.searchParams.get('id') || '';
      const historyArtists = (urlObj.searchParams.get('historyArtists') || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      const excludeNorm = normalizeTitle(title);

      let candidates = [];
      if (currentId && /^[a-zA-Z0-9_-]{11}$/.test(currentId)) {
        candidates = await fetchYTMusicRadio(currentId).catch(() => []);
      }

      // Blend songs from user's recent listening history artists
      if (historyArtists.length > 0) {
        const tasteArtist = historyArtists.find(a => a.toLowerCase() !== uploader.toLowerCase()) || historyArtists[0];
        if (tasteArtist) {
          const tasteSongs = await searchYouTubeMusic(tasteArtist, 'EgWKAQIIAWoMEA4QChADEAQQCRAF').catch(() => []);
          candidates.push(...tasteSongs.slice(0, 4).map(s => ({ ...s, mediaType: 'audio', platform: 'YT Music' })));
        }
      }

      // Fallback if RDAMVM returned empty
      if (candidates.length === 0 && uploader && uploader.toLowerCase() !== 'unknown') {
        const artistSongs = await searchYouTubeMusic(uploader, 'EgWKAQIIAWoMEA4QChADEAQQCRAF').catch(() => []);
        candidates.push(...artistSongs.map(s => ({ ...s, mediaType: 'audio', platform: 'YT Music' })));
      }

      const seenIds = new Set([currentId]);
      const seenNorms = new Set([excludeNorm]);
      const finalQueue = [];

      for (const item of candidates) {
        if (!item?.id || seenIds.has(item.id)) continue;
        const norm = normalizeTitle(item.title);
        if (!norm || seenNorms.has(norm)) continue;
        if (excludeNorm.length > 4 && (norm.includes(excludeNorm) || excludeNorm.includes(norm))) continue;
        seenIds.add(item.id);
        seenNorms.add(norm);
        finalQueue.push(item);
      }

      return res.status(200).json(finalQueue.slice(0, 12));
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
      const isAudioPlatform = /soundcloud\.com|spotify\.com|music\.youtube\.com|deezer\.com/i.test(targetUrl);
      return res.status(200).json({
        id: String(Date.now()),
        title: oembed.title || 'Direct Media',
        uploader: oembed.author_name || oembed.provider_name || 'Web',
        duration: 0,
        thumbnail: oembed.thumbnail_url || '',
        url: targetUrl,
        mediaType: isAudioPlatform ? 'audio' : 'video'
      });
    }

    if (pathname === '/api/resolve-stream') {
      const targetUrl = urlObj.searchParams.get('url');
      const mode = urlObj.searchParams.get('mode') || 'audio';
      const quality = urlObj.searchParams.get('quality') || '720';
      const resolved = await resolveWorkingMedia(targetUrl, mode);
      return res.status(200).json({
        directUrl: resolved.url,
        mime: resolved.mime,
        proxyUrl: `https://${req.headers.host}/api/stream?url=${encodeURIComponent(targetUrl)}&mode=${mode}&quality=${quality}`
      });
    }

    if (pathname === '/api/stream') {
      const targetUrl = urlObj.searchParams.get('url');
      const mode = urlObj.searchParams.get('mode') || 'audio';
      const startByte = parseInt(urlObj.searchParams.get('start') || '0', 10);
      const chunkSize = 2.5 * 1024 * 1024;

      const resolved = await resolveWorkingMedia(targetUrl, mode);

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
        throw new Error(`Upstream HTTP ${upstream.status}`);
      }

      const contentRange = upstream.headers.get('content-range');
      if (contentRange) res.setHeader('Content-Range', contentRange);
      res.setHeader('Content-Type', resolved.mime || (mode === 'audio' ? 'audio/mpeg' : 'video/mp4'));
      res.setHeader('Accept-Ranges', 'bytes');

      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader('Content-Length', buf.length);
      return res.status(upstream.status === 206 ? 206 : 200).send(buf);
    }

    return res.status(200).json({ status: 'ready' });
  } catch (err) {
    const details = Array.isArray(err.errors)
      ? err.errors.map(e => e?.message || String(e))
      : undefined;
    return res.status(500).json({ error: err.message || 'Resolution failed', details });
  }
};
