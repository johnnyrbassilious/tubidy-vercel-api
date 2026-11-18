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

// Multi-Engine Stream & Download Resolver (Works on Vercel IPs without YouTube Bot Blocks)
async function resolveWorkingMedia(targetUrl, mode = 'audio', quality = '720') {
  const videoId = extractYouTubeId(targetUrl);
  const fullUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : targetUrl;
  const qNum = parseInt(String(quality).replace(/\D/g, ''), 10) || 720;
  const tasks = [];

  // Engine 1: Loader.to / Oceansaver API (Reliable on Vercel IPs for MP3 Audio & MP4 Video)
  tasks.push((async () => {
    const format = mode === 'audio' ? 'mp3' : String(qNum);
    const initRes = await fetchTimeout(
      `https://ab.cococococ.com/ajax/download.php?copyright=0&format=${format}&url=${encodeURIComponent(fullUrl)}&api=dfcb6d76f2f6a9894gjkege8a4ab232222`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)' } },
      5000
    );
    if (!initRes.ok) throw new Error('Loader init failed');
    const initData = await initRes.json();
    if (!initData || !initData.id) throw new Error('No Loader task ID');

    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, 900));
      const progRes = await fetchTimeout(`https://p.oceansaver.in/ajax/progress.php?id=${initData.id}`, {}, 4000);
      if (!progRes.ok) continue;
      const progData = await progRes.json();
      if (progData && progData.download_url) {
        return {
          url: progData.download_url,
          mime: mode === 'audio' ? 'audio/mpeg' : 'video/mp4'
        };
      }
    }
    throw new Error('Loader timeout');
  })());

  // Engine 2: Savetube CDN Extractor (Fast Audio & Video Direct CDN Streams)
  tasks.push((async () => {
    const cdnRes = await fetchTimeout('https://media.savetube.me/api/random-cdn', {}, 3500);
    const cdnData = cdnRes.ok ? await cdnRes.json() : { cdn: 'cdn54.savetube.su' };
    const cdnHost = cdnData.cdn || 'cdn54.savetube.su';

    const infoRes = await fetchTimeout(`https://${cdnHost}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({ url: fullUrl })
    }, 4500);
    if (!infoRes.ok) throw new Error('Savetube info failed');
    const infoJson = await infoRes.json();
    const key = infoJson?.data?.key;
    if (!key) throw new Error('No Savetube key');

    const dlRes = await fetchTimeout(`https://${cdnHost}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({
        downloadType: mode === 'audio' ? 'audio' : 'video',
        quality: mode === 'audio' ? '128' : String(qNum),
        key
      })
    }, 5000);
    if (!dlRes.ok) throw new Error('Savetube dl failed');
    const dlJson = await dlRes.json();
    const dlUrl = dlJson?.data?.downloadUrl;
    if (dlUrl) {
      return {
        url: dlUrl,
        mime: mode === 'audio' ? 'audio/mpeg' : 'video/mp4'
      };
    }
    throw new Error('No Savetube URL');
  })());

  // Engine 3: Active 2026 Piped & Invidious Proxied Streams
  if (videoId) {
    const pipedNodes = [
      'https://api.piped.private.coffee',
      'https://pipedapi.drgns.space',
      'https://pipedapi.adminforge.de',
      'https://pipedapi.reallyaweso.me'
    ];
    for (const node of pipedNodes) {
      tasks.push((async () => {
        const res = await fetchTimeout(`${node}/streams/${videoId}`, {}, 4000);
        if (!res.ok) throw new Error('Piped status ' + res.status);
        const data = await res.json();
        if (mode === 'audio' && Array.isArray(data.audioStreams) && data.audioStreams.length > 0) {
          const best = data.audioStreams.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
          if (best && best.url) return { url: best.url, mime: best.mimeType || 'audio/mp4' };
        }
        const vids = (data.videoStreams || []).filter(v => v.videoOnly === false);
        const pool = vids.length > 0 ? vids : (data.videoStreams || []);
        const match = pool.find(v => (v.quality || '').includes(String(qNum))) || pool[0];
        if (match && match.url) return { url: match.url, mime: 'video/mp4' };
        throw new Error('No Piped stream');
      })());
    }

    const invNodes = [
      'https://inv.nadeko.net',
      'https://invidious.nerdvpn.de',
      'https://iv.datura.network',
      'https://invidious.perennialte.ch'
    ];
    for (const node of invNodes) {
      tasks.push((async () => {
        const res = await fetchTimeout(`${node}/api/v1/videos/${videoId}`, {}, 4000);
        if (!res.ok) throw new Error('Invidious failed');
        const data = await res.json();
        if (mode === 'audio' && Array.isArray(data.adaptiveFormats)) {
          const aud = data.adaptiveFormats
            .filter(f => (f.type || '').startsWith('audio/'))
            .sort((a, b) => (parseInt(b.bitrate || 0) - parseInt(a.bitrate || 0)))[0];
          if (aud && aud.itag) {
            return { url: `${node}/latest_version?id=${videoId}&itag=${aud.itag}&local=true`, mime: 'audio/mp4' };
          }
        }
        const fmt = (data.formatStreams || [])[0];
        if (fmt && fmt.itag) {
          return { url: `${node}/latest_version?id=${videoId}&itag=${fmt.itag}&local=true`, mime: 'video/mp4' };
        }
        throw new Error('No Inv format');
      })());
    }
  }

  // Engine 4: Cobalt Multi-Platform Nodes (YouTube, TikTok, SoundCloud, Instagram)
  const cobaltNodes = [
    'https://cobalt-backend.canine.tools',
    'https://cobalt-api.kwiatekmiki.com',
    'https://c.blahaj.ca'
  ];
  for (const node of cobaltNodes) {
    tasks.push((async () => {
      const res = await fetchTimeout(`${node}/`, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: fullUrl,
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

    // 1. YOUTUBE MUSIC AUTOCOMPLETE & TYPO SUGGESTIONS
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

    // 2. SMART PLATFORM-SEPARATED SEARCH (ALL, AUDIO, VIDEO, PODCAST, RADIO) + TYPO RECOVERY
    if (pathname === '/api/search') {
      let q = (urlObj.searchParams.get('q') || '').trim();
      const filter = (urlObj.searchParams.get('filter') || 'all').toLowerCase();
      if (!q) return res.status(400).json({ error: 'Missing query' });

      // Typo correction & autocorrect via Google/YouTube Suggest
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

      // B) STRICT AUDIO FILTER (Fetches from iTunes/Apple Music & YouTube Music Topic Audio Catalogs ONLY)
      if (filter === 'audio') {
        const [itunesRes, ytAudioRes] = await Promise.allSettled([
          fetchTimeout(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=12`, {}, 3500)
            .then(r => (r.ok ? r.json() : { results: [] })),
          yts(`${q} topic official audio`)
        ]);

        const itunesTracks = itunesRes.status === 'fulfilled' ? (itunesRes.value.results || []) : [];
        const ytVideos = ytAudioRes.status === 'fulfilled' ? (ytAudioRes.value.videos || []) : [];

        const audioResults = [];
        const seenIds = new Set();

        for (const v of ytVideos) {
          const lower = (v.title || '').toLowerCase();
          // Exclude music videos / live footage from the strict Audio filter
          if (lower.includes('official music video') || lower.includes('music video') || lower.includes('live at')) {
            continue;
          }
          // Pair with high-res square album art from iTunes if available
          const matchedItunes = itunesTracks.find(t =>
            normalizeTitle(t.trackName) === normalizeTitle(v.title) ||
            lower.includes((t.trackName || '').toLowerCase())
          );
          const squareArt = matchedItunes?.artworkUrl100
            ? matchedItunes.artworkUrl100.replace('100x100bb', '600x600bb')
            : (v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`);

          if (!seenIds.has(v.videoId)) {
            seenIds.add(v.videoId);
            audioResults.push({
              id: v.videoId,
              title: matchedItunes ? `${matchedItunes.artistName} - ${matchedItunes.trackName}` : v.title.replace(/\(Official Audio\)|\[Official Audio\]/gi, '').trim(),
              uploader: matchedItunes ? matchedItunes.artistName : ((v.author && v.author.name) ? v.author.name.replace(' - Topic', '') : 'YT Music'),
              duration: v.seconds || Math.round((matchedItunes?.trackTimeMillis || 0) / 1000) || 0,
              thumbnail: squareArt,
              url: `https://www.youtube.com/watch?v=${v.videoId}`,
              mediaType: 'audio',
              platform: 'YT Music'
            });
          }
        }
        return res.status(200).json(audioResults.slice(0, 20));
      }

      // C) STRICT VIDEO FILTER (Fetches strictly Video MP4 items, excluding Topic audio-only tracks)
      if (filter === 'video') {
        let r = await yts(`${q} video`);
        if (!r.videos || r.videos.length === 0) r = await yts(correctedQuery);

        const videoResults = (r.videos || [])
          .filter(v => {
            const authorName = (v.author && v.author.name) ? v.author.name : '';
            const lowerTitle = (v.title || '').toLowerCase();
            return !authorName.endsWith('- Topic') && !lowerTitle.includes('official audio');
          })
          .slice(0, 20)
          .map(v => ({
            id: v.videoId,
            title: v.title,
            uploader: (v.author && v.author.name) ? v.author.name : 'YouTube',
            duration: v.seconds || 0,
            thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
            url: v.url || `https://www.youtube.com/watch?v=${v.videoId}`,
            mediaType: 'video',
            platform: 'YouTube'
          }));

        return res.status(200).json(videoResults);
      }

      // D) PODCAST FILTER
      if (filter === 'podcast') {
        let r = await yts(`${q} podcast episode`);
        if (!r.videos || r.videos.length === 0) r = await yts(`${correctedQuery} podcast`);
        const podResults = (r.videos || []).slice(0, 20).map(v => ({
          id: v.videoId,
          title: v.title,
          uploader: (v.author && v.author.name) ? v.author.name : 'Podcast',
          duration: v.seconds || 0,
          thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
          url: v.url || `https://www.youtube.com/watch?v=${v.videoId}`,
          mediaType: 'audio',
          platform: 'Podcast'
        }));
        return res.status(200).json(podResults);
      }

      // E) "ALL" FILTER (Combines distinct Audio tracks and Video items with automatic typo fallback)
      let [rawSearch, audioSearch] = await Promise.all([
        yts(q),
        yts(`${q} official audio`)
      ]);

      if ((!rawSearch.videos || rawSearch.videos.length === 0) && correctedQuery !== q) {
        rawSearch = await yts(correctedQuery);
      }

      const combined = [];
      const seen = new Set();

      const videosList = rawSearch.videos || [];
      const audiosList = audioSearch.videos || [];

      for (let i = 0; i < Math.max(videosList.length, audiosList.length); i++) {
        if (videosList[i] && !seen.has(videosList[i].videoId)) {
          const v = videosList[i];
          seen.add(v.videoId);
          const isTopic = ((v.author && v.author.name) || '').endsWith('- Topic') || (v.title || '').toLowerCase().includes('official audio');
          combined.push({
            id: v.videoId,
            title: v.title,
            uploader: (v.author && v.author.name) ? v.author.name.replace(' - Topic', '') : 'YouTube',
            duration: v.seconds || 0,
            thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
            url: v.url || `https://www.youtube.com/watch?v=${v.videoId}`,
            mediaType: isTopic ? 'audio' : 'video',
            platform: isTopic ? 'YT Music' : 'YouTube'
          });
        }
        if (audiosList[i] && !seen.has(audiosList[i].videoId) && i < 6) {
          const a = audiosList[i];
          seen.add(a.videoId);
          combined.push({
            id: a.videoId,
            title: a.title.replace(/\(Official Audio\)|\[Official Audio\]/gi, '').trim(),
            uploader: (a.author && a.author.name) ? a.author.name.replace(' - Topic', '') : 'YT Music',
            duration: a.seconds || 0,
            thumbnail: a.thumbnail || `https://i.ytimg.com/vi/${a.videoId}/hqdefault.jpg`,
            url: a.url || `https://www.youtube.com/watch?v=${a.videoId}`,
            mediaType: 'audio',
            platform: 'YT Music'
          });
        }
      }

      return res.status(200).json(combined.slice(0, 24));
    }

    // 3. SMART YOUTUBE MUSIC / SPOTIFY-STYLE RELATED ENGINE (Based on History & Artist Similarity, Zero Same-Song Remixes)
    if (pathname === '/api/related') {
      const title = urlObj.searchParams.get('title') || '';
      const uploader = (urlObj.searchParams.get('uploader') || '').replace(' - Topic', '').trim();
      const currentId = urlObj.searchParams.get('id') || '';
      const historyArtists = (urlObj.searchParams.get('historyArtists') || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      const excludeNorm = normalizeTitle(title);

      // Query different songs by the current artist + songs from user's recent listening history artists
      const queries = [];
      if (uploader && uploader.toLowerCase() !== 'unknown') {
        queries.push(`${uploader} best songs official audio`);
      }
      if (historyArtists.length > 0) {
        const tasteArtist = historyArtists[0];
        if (tasteArtist.toLowerCase() !== uploader.toLowerCase()) {
          queries.push(`${tasteArtist} popular songs`);
        }
      }
      if (queries.length === 0) {
        queries.push(`${title} similar songs mix`);
      }

      const searchResults = await Promise.all(queries.map(q => yts(q).catch(() => ({ videos: [] }))));
      const pool = [];
      const seenIds = new Set([currentId]);
      const seenNormTitles = new Set([excludeNorm]);

      for (const resBlock of searchResults) {
        for (const v of (resBlock.videos || [])) {
          if (!v || !v.videoId || seenIds.has(v.videoId)) continue;
          const candNorm = normalizeTitle(v.title);
          // Strictly block other uploads/lyrics/remixes of the exact same song
          if (
            !candNorm ||
            seenNormTitles.has(candNorm) ||
            (excludeNorm.length > 4 && (candNorm.includes(excludeNorm) || excludeNorm.includes(candNorm)))
          ) {
            continue;
          }
          seenIds.add(v.videoId);
          seenNormTitles.add(candNorm);
          pool.push({
            id: v.videoId,
            title: v.title,
            uploader: (v.author && v.author.name) ? v.author.name.replace(' - Topic', '') : uploader,
            duration: v.seconds || 0,
            thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
            url: v.url || `https://www.youtube.com/watch?v=${v.videoId}`,
            mediaType: 'audio',
            platform: 'YT Music'
          });
        }
      }

      return res.status(200).json(pool.slice(0, 10));
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
      const resolved = await resolveWorkingMedia(targetUrl, mode, quality);
      return res.status(200).json({
        directUrl: resolved.url,
        mime: resolved.mime,
        proxyUrl: `https://${req.headers.host}/api/stream?url=${encodeURIComponent(targetUrl)}&mode=${mode}&quality=${quality}`
      });
    }

    if (pathname === '/api/stream') {
      const targetUrl = urlObj.searchParams.get('url');
      const mode = urlObj.searchParams.get('mode') || 'audio';
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
    return res.status(500).json({ error: err.message || 'Resolution failed' });
  }
};
