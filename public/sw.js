/*
 * The service worker of the web build: what lets the app open and play what
 * it played recently without a network.
 *
 * A browser has no file system to download into, so the offline the phone
 * offers is not on the menu; what is on it is a cache of everything that has
 * gone past, kept within a budget:
 *
 *   · the app itself, so the page opens at all with no network;
 *   · covers, kept as they are first seen;
 *   · the answers the library screens are built from, served from the network
 *     when there is one and from the last answer when there is not;
 *   · the songs that were played. A player asks for a song in ranges, which a
 *     cache cannot answer piece by piece, so the whole song is fetched once
 *     more in the background and kept, and from then on ranges are cut out of
 *     the copy. The most recent songs stay, up to a budget in bytes.
 *
 * Nothing that changes anything on the server goes through the cache, and
 * nothing of a Jam does: those answers are the present moment, not the past.
 */
const VERSION = 'v1';
const SHELL = `shell-${VERSION}`;
const COVERS = `covers-${VERSION}`;
const API = `api-${VERSION}`;
const TRACKS = `tracks-${VERSION}`;
const INDEX_URL = '/__tracks_index__';

/** Songs kept, at most, and the room they may take together. */
const TRACK_BUDGET_BYTES = 400 * 1024 * 1024;
const TRACK_MAX_COUNT = 120;
const COVER_MAX_COUNT = 600;
const API_MAX_COUNT = 400;

/** The read-only Subsonic and Navifind answers the screens are built from. */
const CACHEABLE_API = /\/rest\/(getAlbumList2?|getAlbum|getArtists|getArtist|getArtistInfo2?|getPlaylists|getPlaylist|getStarred2?|getMusicFolders|getIndexes|getMusicDirectory|getGenres|getSongsByGenre|getSong|getTopSongs|getSimilarSongs2?|getLyricsBySongId|getAlbumInfo2?|search3|navifind\/youtube\/[a-z/]+)(\.view)?(\?|$)/;
const STREAM = /\/rest\/stream(\.view)?\?/;
const COVER = /\/rest\/getCoverArt(\.view)?\?/;
const APP_SHELL = /\/app\/(_expo|assets)\//;

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Caches of another version are another version's.
      for (const name of await caches.keys()) {
        if (!name.endsWith(`-${VERSION}`)) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate' && url.pathname.startsWith('/app')) {
    event.respondWith(shellNavigation(request));
  } else if (APP_SHELL.test(url.pathname)) {
    event.respondWith(cacheFirst(SHELL, request));
  } else if (COVER.test(url.pathname + url.search)) {
    event.respondWith(cacheFirst(COVERS, request, COVER_MAX_COUNT));
  } else if (STREAM.test(url.pathname + url.search)) {
    event.respondWith(track(request));
  } else if (CACHEABLE_API.test(url.pathname + url.search)) {
    event.respondWith(networkFirst(API, request, API_MAX_COUNT));
  }
});

/** The page: the network's copy, else the last one, so the app opens offline. */
async function shellNavigation(request) {
  const cache = await caches.open(SHELL);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) await cache.put('/app/index.html', fresh.clone());
    return fresh;
  } catch {
    return (await cache.match('/app/index.html')) ?? Response.error();
  }
}

async function cacheFirst(name, request, maxCount) {
  const cache = await caches.open(name);
  const hit = await cache.match(request);
  if (hit) return hit;
  const fresh = await fetch(request);
  if (fresh.ok) {
    await cache.put(request, fresh.clone());
    if (maxCount) void trim(cache, maxCount);
  }
  return fresh;
}

async function networkFirst(name, request, maxCount) {
  const cache = await caches.open(name);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) {
      await cache.put(request, fresh.clone());
      void trim(cache, maxCount);
    }
    return fresh;
  } catch (e) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw e;
  }
}

/** Keeps a cache to its newest entries; the Cache API lists them oldest first. */
async function trim(cache, maxCount) {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - maxCount))) await cache.delete(key);
}

// ── Songs ─────────────────────────────────────────────────────────────────

/** What is kept of each song: when it was last wanted, and its size. */
async function readIndex(cache) {
  const hit = await cache.match(INDEX_URL);
  if (!hit) return {};
  try {
    return await hit.json();
  } catch {
    return {};
  }
}

async function writeIndex(cache, index) {
  await cache.put(INDEX_URL, new Response(JSON.stringify(index), { headers: { 'Content-Type': 'application/json' } }));
}

/** The song's address without the range, which is how the copy is keyed. */
function trackKey(request) {
  return request.url;
}

const fetching = new Set();

async function track(request) {
  const cache = await caches.open(TRACKS);
  const key = trackKey(request);
  const whole = await cache.match(key);
  if (whole) {
    void touch(cache, key);
    return sliced(whole, request.headers.get('Range'));
  }
  // Not kept yet: the player gets the network as it asked, and the whole
  // song is fetched once behind it and kept for next time.
  if (!fetching.has(key)) {
    fetching.add(key);
    keep(cache, key).finally(() => fetching.delete(key));
  }
  return fetch(request);
}

async function keep(cache, key) {
  try {
    const whole = await fetch(key, { headers: { Range: '' } });
    if (!whole.ok || whole.status !== 200) return;
    const body = await whole.arrayBuffer();
    if (body.byteLength === 0 || body.byteLength > TRACK_BUDGET_BYTES / 4) return;
    const headers = new Headers();
    headers.set('Content-Type', whole.headers.get('Content-Type') || 'audio/mpeg');
    headers.set('Content-Length', String(body.byteLength));
    await cache.put(key, new Response(body, { status: 200, headers }));
    const index = await readIndex(cache);
    index[key] = { at: Date.now(), size: body.byteLength };
    await evict(cache, index);
    await writeIndex(cache, index);
  } catch {
    // No network, or a stream the server would not give whole: nothing kept.
  }
}

async function touch(cache, key) {
  const index = await readIndex(cache);
  if (index[key]) {
    index[key].at = Date.now();
    await writeIndex(cache, index);
  }
}

/** The oldest songs go until the rest fit the budget. */
async function evict(cache, index) {
  let entries = Object.entries(index).sort((a, b) => b[1].at - a[1].at);
  let total = 0;
  const kept = [];
  for (const [key, meta] of entries) {
    if (kept.length < TRACK_MAX_COUNT && total + meta.size <= TRACK_BUDGET_BYTES) {
      kept.push(key);
      total += meta.size;
    } else {
      await cache.delete(key);
      delete index[key];
    }
  }
}

/** The part of a kept song a range asks for, the way a server would answer it. */
async function sliced(whole, range) {
  const body = await whole.arrayBuffer();
  const total = body.byteLength;
  const type = whole.headers.get('Content-Type') || 'audio/mpeg';
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (!m) {
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': type, 'Content-Length': String(total), 'Accept-Ranges': 'bytes' },
    });
  }
  let start = m[1] === '' ? Math.max(0, total - Number(m[2])) : Number(m[1]);
  let end = m[2] === '' || m[1] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
  if (start > end || start >= total) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
  }
  return new Response(body.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': type,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
    },
  });
}
