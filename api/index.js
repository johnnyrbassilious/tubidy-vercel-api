const ytdl = require('@distube/ytdl-core');

async function fetchTimeout(url, options = {}, ms = 6500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { redirect: 'follow', ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeTitle(str = '') {
  return String(str)
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/official|video|audio|lyrics|hd|4k|remastered/gi, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function deduplicateItems(items) {
  const seenIds = new Set();
  const seenKeys = new Set();
  const out = [];

  for (const item of items) {
    if (!item || !item.id || seenIds.has(item.id)) continue;
    const normTitle = normalizeTitle(item.title);
    const normArtist = normalizeTitle(item.uploader);
    const key = `${normTitle}::${normArtist}::${item.mediaType || ''}`;
    if (normTitle && seenKeys.has(key)) continue;

    seenIds.add(item.id);
    if (normTitle) seenKeys.add(key);
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// YOUTUBE / YOUTUBE MUSIC (InnerTube, no API key)
// ---------------------------------------------------------------------------

const YT_CLIENTS = [
  {
    name: 'VISIONOS',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
    cn: '101',
    cv: '1.02',
    body: {
      clientName: 'VISIONOS',
      clientVersion: '1.02',
      deviceMake: 'Apple',
      deviceModel: 'RealityDevice17,1',
      osName: 'visionOS',
      osVersion: '26.5.23O471',
      hl: 'en',
      gl: 'US'
    }
  },
  {
    name: 'ANDROID_VR',
    ua: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    cn: '28',
    cv: '1.65.10',
    body: {
      clientName: 'ANDROID_VR',
      clientVersion: '1.65.10',
      deviceMake: 'Oculus',
      deviceModel: 'Quest 3',
      androidSdkVersion: 32,
      osName: 'Android',
      osVersion: '12L',
      hl: 'en',
      gl: 'US'
    }
  },
  {
    name: 'IOS',
    ua: 'com.google.ios.youtube/20.11.6 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    cn: '5',
    cv: '20.11.6',
    body: {
      clientName: 'IOS',
      clientVersion: '20.11.6',
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      osName: 'iPhone',
      osVersion: '18.3.2.22D82',
      hl: 'en',
      gl: 'US'
    }
  },
  {
    name: 'TVHTML5',
    ua: 'Mozilla/5.0 (PlayStation; PlayStation 5/2.26) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0 Safari/605.1.15',
    cn: '85',
    cv: '2.0',
    body: {
      clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
      clientVersion: '2.0',
      hl: 'en',
      gl: 'US'
    }
  },
  {
    name: 'WEB',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    cn: '1',
    cv: '2.20241010.01.00',
    body: { clientName: 'WEB', clientVersion: '2.20241010.01.00', hl: 'en', gl: 'US' }
  }
];

function extractYouTubeId(raw) {
  if (!raw) return null;
  const str = String(raw);
  if (/^[a-zA-Z0-9_-]{11}$/.test(str)) return str;
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /\/shorts\/([a-zA-Z0-9_-]{11})/,
    /\/embed\/([a-zA-Z0-9_-]{11})/,
    /\/live\/([a-zA-Z0-9_-]{11})/
  ];
  for (const re of patterns) {
    const m = re.exec(str);
    if (m) return m[1];
  }
  return null;
}

async function innertubePlayer(videoId) {
  for (const client of YT_CLIENTS) {
    try {
      const resp = await fetchTimeout(
        'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': client.ua,
            'X-YouTube-Client-Name': client.cn,
            'X-YouTube-Client-Version': client.cv,
            Origin: 'https://www.youtube.com'
          },
          body: JSON.stringify({
            videoId,
            context: { client: client.body },
            contentCheckOk: true,
            racyCheckOk: true
          })
        },
        8000
      );
      if (!resp.ok) continue;
      const json = await resp.json();
      if (json?.playabilityStatus?.status && json.playabilityStatus.status !== 'OK') continue;
      if (!json?.streamingData) continue;
      return json.streamingData;
    } catch (_) {
      // try next client
    }
  }
  return null;
}

function pickYouTubeFormat(streamingData, mode, quality) {
  const formats = Array.isArray(streamingData.formats) ? streamingData.formats : [];
  const adaptive = Array.isArray(streamingData.adaptiveFormats) ? streamingData.adaptiveFormats : [];
  const hls = typeof streamingData.hlsManifestUrl === 'string' ? streamingData.hlsManifestUrl : null;

  const withUrl = (f) => f && typeof f.url === 'string' && f.url.length > 0;
  const mimeOf = (f) => String(f.mimeType || '');

  if (mode === 'audio') {
    const audio = [...adaptive, ...formats].filter((f) => withUrl(f) && mimeOf(f).startsWith('audio/'));
    const mp4 = audio.filter((f) => mimeOf(f).toLowerCase().includes('audio/mp4'));
    const pool = mp4.length ? mp4 : audio;
    if (pool.length) {
      const sorted = [...pool].sort(
        (a, b) => Number(b.bitrate || b.averageBitrate || 0) - Number(a.bitrate || a.averageBitrate || 0)
      );
      return { url: sorted[0].url, mime: mimeOf(sorted[0]).split(';')[0] || 'audio/mp4' };
    }
    if (hls) return { url: hls, mime: 'application/x-mpegURL' };
    return null;
  }

  const desired = parseInt(String(quality).replace(/\D/g, ''), 10) || 720;

  // Progressive first: single file with picture + sound, ideal for the proxy
  const progressive = formats.filter((f) => withUrl(f) && mimeOf(f).includes('video/mp4'));
  if (progressive.length) {
    const sorted = [...progressive].sort((a, b) => Number(b.height || 0) - Number(a.height || 0));
    const chosen =
      sorted.find((f) => Number(f.height || 0) === desired) ||
      sorted.find((f) => Number(f.height || 0) > 0 && Number(f.height || 0) <= desired) ||
      sorted[sorted.length - 1];
    return { url: chosen.url, mime: mimeOf(chosen).split(';')[0] || 'video/mp4' };
  }

  if (hls) return { url: hls, mime: 'application/x-mpegURL' };

  // Adaptive video-only (client muxes audio separately)
  const video = adaptive.filter((f) => withUrl(f) && mimeOf(f).startsWith('video/mp4'));
  if (video.length) {
    const capped = video.filter((f) => Number(f.height || 0) > 0 && Number(f.height || 0) <= desired);
    const sorted = [...(capped.length ? capped : video)].sort(
      (a, b) => Number(b.height || 0) - Number(a.height || 0)
    );
    return { url: sorted[0].url, mime: mimeOf(sorted[0]).split(';')[0] || 'video/mp4' };
  }

  return null;
}

async function resolveYouTube(targetUrl, mode, quality) {
  const videoId = extractYouTubeId(targetUrl);
  if (!videoId) throw new Error('Invalid YouTube URL');

  const streamingData = await innertubePlayer(videoId);
  if (streamingData) {
    const picked = pickYouTubeFormat(streamingData, mode, quality);
    if (picked) return picked;
  }

  // Fallback: ytdl-core
  try {
    const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`);
    const picked = pickYouTubeFormat(info.streamingData, mode, quality);
    if (picked) return picked;
  } catch (_) {
    // fall through
  }

  throw new Error('Could not resolve this YouTube video');
}

function parseDurationText(text) {
  if (!text) return 0;
  const parts = String(text).split(':').map((p) => parseInt(p, 10));
  if (parts.some((p) => Number.isNaN(p))) return 0;
  return parts.reduce((acc, part) => acc * 60 + part, 0);
}

async function searchYouTube(query, limit = 20, musicOnly = false) {
  const client = musicOnly
    ? {
        name: 'WEB_REMIX',
        ua: YT_CLIENTS[4].ua,
        cn: '67',
        cv: '1.20241009.01.00',
        body: { clientName: 'WEB_REMIX', clientVersion: '1.20241009.01.00', hl: 'en', gl: 'US' }
      }
    : YT_CLIENTS[4];

  const origin = musicOnly ? 'https://music.youtube.com' : 'https://www.youtube.com';

  const resp = await fetchTimeout(
    'https://www.youtube.com/youtubei/v1/search?prettyPrint=false',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': client.ua,
        'X-YouTube-Client-Name': client.cn,
        'X-YouTube-Client-Version': client.cv,
        Origin: origin
      },
      body: JSON.stringify({
        query,
        context: { client: client.body }
      })
    },
    7000
  );

  if (!resp.ok) return [];
  const json = await resp.json();

  const collect = (node, out) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((child) => collect(child, out));
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'videoRenderer' && value && typeof value === 'object') {
        out.push(value);
      } else if (key === 'playlistVideoRenderer' && value && typeof value === 'object') {
        out.push(value);
      } else {
        collect(value, out);
      }
    }
  };

  const renderers = [];
  collect(json.contents, renderers);

  const seen = new Set();
  const items = [];

  for (const r of renderers) {
    const videoId = r.videoId;
    if (!videoId || seen.has(videoId)) continue;

    const title =
      r.title?.runs?.[0]?.text ||
      r.title?.simpleText ||
      r.headline?.simpleText ||
      '';
    if (!title) continue;

    const uploader =
      r.ownerText?.runs?.[0]?.text ||
      r.longBylineText?.runs?.[0]?.text ||
      r.shortBylineText?.runs?.[0]?.text ||
      'YouTube';

    const thumbs = r.thumbnail?.thumbnails;
    const thumbnail = Array.isArray(thumbs) && thumbs.length ? String(thumbs[thumbs.length - 1].url) : '';

    seen.add(videoId);
    items.push({
      id: `yt_${videoId}`,
      videoId,
      title: String(title).trim(),
      uploader: String(uploader).trim(),
      duration: parseDurationText(r.lengthText?.simpleText),
      thumbnail,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      mediaType: musicOnly ? 'audio' : 'video',
      platform: musicOnly ? 'YT Music' : 'YouTube'
    });

    if (items.length >= limit) break;
  }

  return items;
}

// 1. AUDIUS (Open Decentralized Music — 320kbps direct MP3, no API key)
let cachedAudiusHost = null;
async function getAudiusHost() {
  if (cachedAudiusHost) return cachedAudiusHost;
  try {
    const res = await fetchTimeout('https://api.audius.co', {}, 3000);
    if (res.ok) {
      const json = await res.json();
      if (Array.isArray(json.data) && json.data.length > 0) {
        cachedAudiusHost = json.data[0].replace(/\/+$/, '');
        return cachedAudiusHost;
      }
    }
  } catch (_) {}
  return 'https://discoveryprovider.audius.co';
}

async function searchAudius(query, limit = 15) {
  const host = await getAudiusHost();
  const res = await fetchTimeout(
    `${host}/v1/tracks/search?query=${encodeURIComponent(query)}&app_name=Jtunes`,
    {},
    4500
  );
  if (!res.ok) return [];
  const json = await res.json();
  const tracks = Array.isArray(json.data) ? json.data : [];

  return tracks
    .filter((t) => t && t.id && t.title && t.is_streamable !== false)
    .slice(0, limit)
    .map((t) => {
      const streamUrl = `${host}/v1/tracks/${encodeURIComponent(t.id)}/stream?app_name=Jtunes`;
      const artwork =
        t.artwork?.['480x480'] ||
        t.artwork?.['1000x1000'] ||
        t.artwork?.['150x150'] ||
        'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=400&q=80';
      return {
        id: `audius_${t.id}`,
        title: String(t.title).trim(),
        uploader: String(t.user?.name || 'Audius Artist').trim(),
        duration: Number(t.duration) || 0,
        thumbnail: artwork,
        url: streamUrl,
        directStreamUrl: streamUrl,
        mediaType: 'audio',
        platform: 'Audius'
      };
    });
}

// 2. APPLE ITUNES PODCAST EPISODES (Direct MP3/M4A episodeUrl, no API key)
async function searchPodcastEpisodes(query, limit = 15) {
  const res = await fetchTimeout(
    `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=podcast&entity=podcastEpisode&limit=${limit}`,
    {},
    4500
  );
  if (!res.ok) return [];
  const json = await res.json();
  const results = Array.isArray(json.results) ? json.results : [];

  return results
    .filter((ep) => ep && typeof ep.episodeUrl === 'string' && /^https?:\/\//i.test(ep.episodeUrl))
    .map((ep) => ({
      id: `pod_${ep.trackId || ep.episodeGuid || Date.now()}`,
      title: String(ep.trackName || ep.collectionName || 'Podcast Episode').trim(),
      uploader: String(ep.collectionName || ep.artistName || 'Podcast').trim(),
      duration: Math.round((Number(ep.trackTimeMillis) || 0) / 1000),
      thumbnail:
        ep.artworkUrl600 ||
        ep.artworkUrl160 ||
        'https://images.unsplash.com/photo-1478737270239-2f02b77fc618?w=400&q=80',
      url: ep.episodeUrl,
      directStreamUrl: ep.episodeUrl,
      mediaType: 'audio',
      platform: 'Podcast'
    }));
}

// 3. OPENVERSE AUDIO (Creative Commons Music & Soundscapes — filtered to iOS-compatible formats)
async function searchOpenverseAudio(query, limit = 12) {
  const res = await fetchTimeout(
    `https://api.openverse.org/v1/audio/?q=${encodeURIComponent(query)}&page_size=${limit}`,
    { headers: { 'User-Agent': 'Jtunes/1.0' } },
    4500
  );
  if (!res.ok) return [];
  const json = await res.json();
  const results = Array.isArray(json.results) ? json.results : [];
  const iosSafeTypes = new Set(['mp3', 'm4a', 'wav', 'aac', 'mp4']);

  return results
    .filter((item) => {
      if (!item || typeof item.url !== 'string' || !/^https:\/\//i.test(item.url)) return false;
      const ft = String(item.filetype || '').toLowerCase();
      return iosSafeTypes.has(ft) || /\.(mp3|m4a|wav|aac)(\?|$)/i.test(item.url);
    })
    .map((item) => ({
      id: `ov_${item.id}`,
      title: String(item.title || 'Open Audio').trim(),
      uploader: String(item.creator || 'Openverse').trim(),
      duration: Math.round((Number(item.duration) || 0) / 1000),
      thumbnail:
        item.thumbnail ||
        'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=400&q=80',
      url: item.url,
      directStreamUrl: item.url,
      mediaType: 'audio',
      platform: 'Openverse'
    }));
}

// 4. INTERNET ARCHIVE (Massive open Audio + Video catalog — resolves to direct MP3/MP4)
async function searchInternetArchive(query, mediaKind = 'audio', limit = 12) {
  const safeQ = query.replace(/["():]/g, ' ').trim();
  if (!safeQ) return [];
  const mediatypeFilter = mediaKind === 'video' ? 'mediatype:(movies)' : 'mediatype:(audio OR etree)';
  const fullQ = `(${safeQ}) AND ${mediatypeFilter}`;
  const searchUrl =
    `https://archive.org/advancedsearch.php?q=${encodeURIComponent(fullQ)}` +
    `&fl[]=identifier&fl[]=title&fl[]=creator&sort[]=downloads+desc&rows=${limit}&page=1&output=json`;

  const res = await fetchTimeout(searchUrl, {}, 4500);
  if (!res.ok) return [];
  const json = await res.json();
  const docs = Array.isArray(json?.response?.docs) ? json.response.docs : [];

  return docs
    .filter((d) => d && d.identifier && d.title)
    .map((d) => {
      const id = String(d.identifier);
      const creator = Array.isArray(d.creator) ? d.creator[0] : d.creator;
      return {
        id: `ia_${mediaKind}_${id}`,
        title: String(Array.isArray(d.title) ? d.title[0] : d.title).trim(),
        uploader: String(creator || 'Internet Archive').trim(),
        duration: 0,
        thumbnail: `https://archive.org/services/img/${encodeURIComponent(id)}`,
        url: `https://archive.org/details/${encodeURIComponent(id)}`,
        mediaType: mediaKind === 'video' ? 'video' : 'audio',
        platform: 'Archive.org'
      };
    });
}

async function resolveInternetArchiveFile(identifier, mode = 'audio') {
  const res = await fetchTimeout(
    `https://archive.org/metadata/${encodeURIComponent(identifier)}`,
    {},
    5000
  );
  if (!res.ok) throw new Error(`Archive metadata HTTP ${res.status}`);
  const data = await res.json();
  const files = Array.isArray(data.files) ? data.files : [];

  if (mode === 'video') {
    const mp4s = files.filter(
      (f) => f && typeof f.name === 'string' && /\.mp4$/i.test(f.name) && !/_thumb|sample/i.test(f.name)
    );
    if (mp4s.length > 0) {
      const chosen =
        mp4s.find((f) => /h\.264|mpeg4/i.test(String(f.format || ''))) || mp4s[0];
      return {
        url: `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(chosen.name).replace(/%2F/g, '/')}`,
        mime: 'video/mp4'
      };
    }
  }

  const audioFiles = files.filter(
    (f) =>
      f &&
      typeof f.name === 'string' &&
      /\.(mp3|m4a|wav)$/i.test(f.name) &&
      !/sample|preview/i.test(f.name)
  );
  if (audioFiles.length > 0) {
    const chosen =
      audioFiles.find((f) => /\.mp3$/i.test(f.name)) ||
      audioFiles.find((f) => /\.m4a$/i.test(f.name)) ||
      audioFiles[0];
    const mime = /\.m4a$/i.test(chosen.name)
      ? 'audio/mp4'
      : /\.wav$/i.test(chosen.name)
        ? 'audio/wav'
        : 'audio/mpeg';
    return {
      url: `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(chosen.name).replace(/%2F/g, '/')}`,
      mime
    };
  }

  throw new Error('No iOS-compatible MP3/MP4 file found in this Archive item');
}

// 5. PEERTUBE VIA SEPIA SEARCH (Unrestricted open-source video network — direct MP4/HLS)
async function searchPeerTube(query, limit = 14) {
  const res = await fetchTimeout(
    `https://sepiasearch.org/api/v1/search/videos?search=${encodeURIComponent(query)}&count=${limit}&nsfw=false`,
    {},
    4500
  );
  if (!res.ok) return [];
  const json = await res.json();
  const videos = Array.isArray(json.data) ? json.data : [];

  return videos
    .filter((v) => v && v.uuid && v.name && (v.account?.host || v.channel?.host || v.url))
    .map((v) => {
      let host = v.account?.host || v.channel?.host || '';
      if (!host && v.url) {
        try {
          host = new URL(v.url).host;
        } catch (_) {}
      }
      const apiDetailUrl = `https://${host}/api/v1/videos/${v.uuid}`;
      return {
        id: `pt_${v.uuid}`,
        title: String(v.name).trim(),
        uploader: String(v.channel?.displayName || v.account?.displayName || 'PeerTube').trim(),
        duration: Number(v.duration) || 0,
        thumbnail:
          v.thumbnailUrl ||
          v.previewUrl ||
          'https://images.unsplash.com/photo-1485846234645-a62644f84728?w=400&q=80',
        url: apiDetailUrl,
        mediaType: 'video',
        platform: 'PeerTube'
      };
    });
}

async function resolvePeerTubeVideo(apiUrl, mode = 'video', quality = '720') {
  const res = await fetchTimeout(apiUrl, {}, 5000);
  if (!res.ok) throw new Error(`PeerTube HTTP ${res.status}`);
  const data = await res.json();

  const desiredHeight = parseInt(String(quality).replace(/\D/g, ''), 10) || 720;
  const rootFiles = Array.isArray(data.files) ? data.files : [];
  const hlsPlaylists = Array.isArray(data.streamingPlaylists) ? data.streamingPlaylists : [];
  const playlistFiles = hlsPlaylists.flatMap((pl) => (Array.isArray(pl.files) ? pl.files : []));
  const allFiles = [...rootFiles, ...playlistFiles].filter(
    (f) => f && (typeof f.fileUrl === 'string' || typeof f.fileDownloadUrl === 'string')
  );

  if (allFiles.length > 0) {
    const sorted = [...allFiles].sort(
      (a, b) => Number(b.resolution?.id || 0) - Number(a.resolution?.id || 0)
    );
    const chosen =
      mode === 'audio'
        ? sorted[sorted.length - 1]
        : sorted.find((f) => Number(f.resolution?.id || 0) === desiredHeight) ||
          sorted.find((f) => Number(f.resolution?.id || 0) > 0 && Number(f.resolution?.id || 0) <= desiredHeight) ||
          sorted[sorted.length - 1];

    const fileUrl = chosen.fileUrl || chosen.fileDownloadUrl;
    return {
      url: fileUrl,
      mime: mode === 'audio' ? 'audio/mp4' : 'video/mp4'
    };
  }

  const hlsUrl = hlsPlaylists.find((pl) => typeof pl.playlistUrl === 'string')?.playlistUrl;
  if (hlsUrl) {
    return { url: hlsUrl, mime: 'application/x-mpegURL' };
  }

  throw new Error('No direct MP4/HLS stream available on this PeerTube instance');
}

// 6. RADIO BROWSER (Filtered strictly to working HTTPS stations for iOS)
async function searchLiveRadio(query, limit = 25) {
  const res = await fetchTimeout(
    `https://de1.api.radio-browser.info/json/stations/search?name=${encodeURIComponent(query)}&hidebroken=true&order=clickcount&reverse=true&limit=${limit}`,
    {},
    4500
  );
  if (!res.ok) return [];
  const stations = await res.json();
  if (!Array.isArray(stations)) return [];

  const httpsOnly = stations.filter(
    (s) => s && typeof s.url_resolved === 'string' && s.url_resolved.startsWith('https://')
  );
  const healthy = httpsOnly.filter((s) => s.lastcheckok === 1);
  const pool = healthy.length > 0 ? healthy : httpsOnly;

  return pool.slice(0, 20).map((s) => ({
    id: `radio_${s.stationuuid}`,
    title: String(s.name || 'Live Radio').trim(),
    uploader: `${s.country || 'Live'} • Radio`,
    duration: 0,
    thumbnail:
      (s.favicon && s.favicon.startsWith('https://') ? s.favicon : '') ||
      'https://images.unsplash.com/photo-1598488035139-bdbb2231ce04?w=400&q=80',
    url: s.url_resolved,
    directStreamUrl: s.url_resolved,
    mediaType: 'audio',
    platform: 'Radio',
    isLiveRadio: true
  }));
}

// UNIFIED UNRESTRICTED MEDIA RESOLVER
async function resolveOpenMedia(targetUrl, mode = 'audio', quality = '720') {
  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    throw new Error('Missing or invalid media URL');
  }

  // YouTube / YouTube Music -> direct googlevideo URL
  if (/youtube\.com|youtu\.be/i.test(targetUrl)) {
    return await resolveYouTube(targetUrl, mode, quality);
  }

  // Internet Archive details page -> resolve direct MP3/MP4
  const iaMatch = targetUrl.match(/archive\.org\/details\/([^/?#]+)/i);
  if (iaMatch) {
    return await resolveInternetArchiveFile(decodeURIComponent(iaMatch[1]), mode);
  }

  // PeerTube API detail URL -> resolve direct MP4/HLS
  if (/\/api\/v1\/videos\/[a-zA-Z0-9-]+/i.test(targetUrl)) {
    return await resolvePeerTubeVideo(targetUrl, mode, quality);
  }

  // Direct stream (Audius, Apple Podcasts MP3, Openverse, Radio, or custom URL)
  const inferredMime =
    /\.mp4(\?|$)/i.test(targetUrl)
      ? 'video/mp4'
      : /\.m4a(\?|$)/i.test(targetUrl)
        ? 'audio/mp4'
        : /\.wav(\?|$)/i.test(targetUrl)
          ? 'audio/wav'
          : /\.m3u8(\?|$)/i.test(targetUrl)
            ? 'application/x-mpegURL'
            : mode === 'video'
              ? 'video/mp4'
              : 'audio/mpeg';

  return { url: targetUrl, mime: inferredMime };
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
      return res.status(200).json({ status: 'online', mode: 'youtube+open-sources', timestamp: Date.now() });
    }

    // 1. AUTOCOMPLETE SUGGESTIONS
    if (pathname === '/api/suggestions') {
      const q = (urlObj.searchParams.get('q') || '').trim();
      if (!q) return res.status(200).json([]);
      try {
        const sugRes = await fetchTimeout(
          `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(q)}`,
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

    // 2. MULTI-SOURCE SEARCH (YouTube + YouTube Music + open sources)
    if (pathname === '/api/search') {
      const q = (urlObj.searchParams.get('q') || '').trim();
      const filter = (urlObj.searchParams.get('filter') || 'all').toLowerCase();
      const source = (urlObj.searchParams.get('source') || 'youtube').toLowerCase();
      if (!q) return res.status(400).json({ error: 'Missing query' });

      const musicOnly = source === 'ytmusic';

      if (filter === 'radio') {
        const stations = await searchLiveRadio(q, 25).catch(() => []);
        return res.status(200).json(stations);
      }

      if (musicOnly) {
        const ytMusic = await searchYouTube(q, 24, true).catch(() => []);
        return res.status(200).json(deduplicateItems(ytMusic).slice(0, 24));
      }

      if (filter === 'podcast' || filter === 'podcasts') {
        const [pods, iaPods] = await Promise.all([
          searchPodcastEpisodes(q, 18).catch(() => []),
          searchInternetArchive(`${q} podcast`, 'audio', 8).catch(() => [])
        ]);
        return res.status(200).json(deduplicateItems([...pods, ...iaPods]).slice(0, 24));
      }

      if (filter === 'video' || filter === 'videos') {
        const [ytVids, ptVids, iaVids] = await Promise.all([
          searchYouTube(q, 16, false).catch(() => []),
          searchPeerTube(q, 10).catch(() => []),
          searchInternetArchive(q, 'video', 8).catch(() => [])
        ]);
        const interleaved = [];
        const maxLen = Math.max(ytVids.length, ptVids.length, iaVids.length);
        for (let i = 0; i < maxLen; i++) {
          if (ytVids[i]) interleaved.push(ytVids[i]);
          if (ptVids[i]) interleaved.push(ptVids[i]);
          if (iaVids[i]) interleaved.push(iaVids[i]);
        }
        return res.status(200).json(deduplicateItems(interleaved).slice(0, 28));
      }

      if (filter === 'audio') {
        const [ytMusic, audius, iaAudio, pods, openverse] = await Promise.all([
          searchYouTube(q, 14, true).catch(() => []),
          searchAudius(q, 10).catch(() => []),
          searchInternetArchive(q, 'audio', 8).catch(() => []),
          searchPodcastEpisodes(q, 4).catch(() => []),
          searchOpenverseAudio(q, 6).catch(() => [])
        ]);
        const interleaved = [];
        const maxLen = Math.max(ytMusic.length, audius.length, iaAudio.length, pods.length, openverse.length);
        for (let i = 0; i < maxLen; i++) {
          if (ytMusic[i]) interleaved.push(ytMusic[i]);
          if (audius[i]) interleaved.push(audius[i]);
          if (iaAudio[i]) interleaved.push(iaAudio[i]);
          if (pods[i]) interleaved.push(pods[i]);
          if (openverse[i]) interleaved.push(openverse[i]);
        }
        return res.status(200).json(deduplicateItems(interleaved).slice(0, 28));
      }

      // "ALL": YouTube first, then music sources, podcasts and videos
      const [ytVids, ytMusic, audius, pods, iaAudio, ptVids, openverse] = await Promise.all([
        searchYouTube(q, 10, false).catch(() => []),
        searchYouTube(q, 8, true).catch(() => []),
        searchAudius(q, 8).catch(() => []),
        searchPodcastEpisodes(q, 6).catch(() => []),
        searchInternetArchive(q, 'audio', 6).catch(() => []),
        searchPeerTube(q, 6).catch(() => []),
        searchOpenverseAudio(q, 4).catch(() => [])
      ]);

      const combined = [];
      const maxLen = Math.max(
        ytVids.length,
        ytMusic.length,
        audius.length,
        pods.length,
        iaAudio.length,
        ptVids.length,
        openverse.length
      );
      for (let i = 0; i < maxLen; i++) {
        if (ytVids[i]) combined.push(ytVids[i]);
        if (ytMusic[i]) combined.push(ytMusic[i]);
        if (audius[i]) combined.push(audius[i]);
        if (pods[i]) combined.push(pods[i]);
        if (iaAudio[i]) combined.push(iaAudio[i]);
        if (ptVids[i]) combined.push(ptVids[i]);
        if (openverse[i]) combined.push(openverse[i]);
      }

      return res.status(200).json(deduplicateItems(combined).slice(0, 30));
    }

    // 3. RELATED AUTOPLAY
    if (pathname === '/api/related') {
      const title = urlObj.searchParams.get('title') || '';
      const uploader = (urlObj.searchParams.get('uploader') || '').trim();
      const currentId = urlObj.searchParams.get('id') || '';
      const excludeNorm = normalizeTitle(title);

      const seedQuery =
        uploader && uploader.toLowerCase() !== 'unknown' && uploader !== 'Audius Artist'
          ? uploader
          : title.split(' ').slice(0, 3).join(' ') || 'chill';

      const [ytMusic, audius, iaAudio] = await Promise.all([
        searchYouTube(seedQuery, 10, true).catch(() => []),
        searchAudius(seedQuery, 6).catch(() => []),
        searchInternetArchive(seedQuery, 'audio', 6).catch(() => [])
      ]);

      const seenIds = new Set([currentId]);
      const seenNorms = new Set([excludeNorm]);
      const finalQueue = [];

      for (const item of [...ytMusic, ...audius, ...iaAudio]) {
        if (!item?.id || seenIds.has(item.id)) continue;
        const norm = normalizeTitle(item.title);
        if (!norm || seenNorms.has(norm)) continue;
        seenIds.add(item.id);
        seenNorms.add(norm);
        finalQueue.push(item);
      }

      return res.status(200).json(finalQueue.slice(0, 12));
    }

    // 4. DIRECT URL INFO
    if (pathname === '/api/info') {
      const targetUrl = urlObj.searchParams.get('url') || '';
      if (!targetUrl) return res.status(400).json({ error: 'Missing url' });

      if (/youtube\.com|youtu\.be/i.test(targetUrl)) {
        const videoId = extractYouTubeId(targetUrl);
        if (videoId) {
          const streamingData = await innertubePlayer(videoId);
          let title = `YouTube ${videoId}`;
          let uploader = 'YouTube';
          let duration = 0;
          try {
            const info = await ytdl.getBasicInfo(`https://www.youtube.com/watch?v=${videoId}`);
            title = info.videoDetails.title || title;
            uploader = info.videoDetails.author?.name || uploader;
            duration = Number(info.videoDetails.lengthSeconds) || 0;
          } catch (_) {
            // Metadata is optional; resolution still works
          }
          return res.status(200).json({
            id: `yt_${videoId}`,
            title,
            uploader,
            duration,
            thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
            url: `https://www.youtube.com/watch?v=${videoId}`,
            mediaType: streamingData ? 'video' : 'audio',
            platform: 'YouTube'
          });
        }
      }

      const isVideo = /\.(mp4|mov|m4v|webm)(\?|$)/i.test(targetUrl);
      const filename = targetUrl.split('/').pop()?.split('?')[0] || 'Direct Media';
      return res.status(200).json({
        id: `direct_${Date.now()}`,
        title: decodeURIComponent(filename),
        uploader: new URL(targetUrl).hostname.replace(/^www\./, ''),
        duration: 0,
        thumbnail: '',
        url: targetUrl,
        directStreamUrl: targetUrl,
        mediaType: isVideo ? 'video' : 'audio',
        platform: 'Direct'
      });
    }

    // 5. STREAM RESOLUTION
    if (pathname === '/api/resolve-stream') {
      const targetUrl = urlObj.searchParams.get('url') || '';
      const mode = urlObj.searchParams.get('mode') || 'audio';
      const quality = urlObj.searchParams.get('quality') || '720';
      const resolved = await resolveOpenMedia(targetUrl, mode, quality);
      return res.status(200).json({
        directUrl: resolved.url,
        mime: resolved.mime,
        proxyUrl: `https://${req.headers.host}/api/stream?url=${encodeURIComponent(targetUrl)}&mode=${mode}&quality=${quality}`
      });
    }

    // 6. CORS-SAFE CHUNKED DOWNLOAD PROXY
    if (pathname === '/api/stream') {
      const targetUrl = urlObj.searchParams.get('url') || '';
      const mode = urlObj.searchParams.get('mode') || 'audio';
      const quality = urlObj.searchParams.get('quality') || '720';
      const startByte = parseInt(urlObj.searchParams.get('start') || '0', 10);
      const chunkSize = 2.5 * 1024 * 1024;

      const resolved = await resolveOpenMedia(targetUrl, mode, quality);

      if (!urlObj.searchParams.has('chunked')) {
        return res.redirect(302, resolved.url);
      }

      const endByte = startByte + chunkSize - 1;
      const upstream = await fetchTimeout(
        resolved.url,
        {
          headers: {
            'Range': `bytes=${startByte}-${endByte}`,
            'User-Agent': 'Jtunes/1.0'
          }
        },
        8000
      );

      if (upstream.headers.get('icy-metaint') || upstream.headers.get('icy-name')) {
        return res.status(400).json({ error: 'Live radio streams cannot be downloaded offline.' });
      }

      if (!upstream.ok && upstream.status !== 206) {
        throw new Error(`Upstream HTTP ${upstream.status}`);
      }

      const contentRange = upstream.headers.get('content-range');
      if (contentRange) res.setHeader('Content-Range', contentRange);
      const ct = upstream.headers.get('content-type') || resolved.mime || 'audio/mpeg';
      res.setHeader('Content-Type', ct);
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
