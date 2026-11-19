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
