
/**
 * Service worker for the 妙境法軒 catalog.
 *
 * Scope of caching, and why it is deliberately narrow:
 *
 *  - The app shell is NOT precached. A Next.js build emits hashed chunk names,
 *    and precaching them would either go stale on every deploy (pinning users
 *    to an old bundle) or require build-time manifest wiring this project does
 *    not have. Instead, navigations are network-first and fall back to the last
 *    successful page copy while offline.
 *  - Media is cached on demand, when the user has already played it. Lectures
 *    are 30–60 minutes each, so a previously listened episode staying available
 *    is the case that actually matters on a commute.
 *  - Media requests are only cached when the response is a complete 200. A 206
 *    partial response must never be stored: replaying a range request from a
 *    truncated body produces silent gaps. Range requests (which media elements
 *    always send) are answered by slicing a complete cached copy; the copy is
 *    fetched once in the background the first time an episode is played.
 */

const SHELL_CACHE = 'fayun-shell-v1';
const MEDIA_CACHE = 'fayun-media-v2';
const MEDIA_CACHE_MAX_ENTRIES = 60;
/** Only media that has been fully fetched is worth keeping. */
const CACHEABLE_MEDIA = /\.(mp3|m4a|aac|ogg|wav|mp4|m4v|webm|pdf)$/i;
/**
 * Media a range request may trigger a full background download for. Video is
 * excluded: a lecture video is hundreds of MB, too much to duplicate silently.
 */
const FILLABLE_MEDIA = /\.(mp3|m4a|aac|ogg|wav|pdf)$/i;
/** Never fill files bigger than this (a 60-minute 128 kbps MP3 is ~58 MB). */
const MEDIA_FILL_MAX_BYTES = 150 * 1024 * 1024;
const MEDIA_FILL_MAX_CONCURRENT = 1;

self.addEventListener('install', (event) => {
  // Take over as soon as the new worker is ready; there is no offline-first
  // shell to keep consistent, so waiting would only delay fixes.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== MEDIA_CACHE)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

/** Keeps the media cache bounded so it cannot consume the whole quota. */
async function trimMediaCache() {
  const cache = await caches.open(MEDIA_CACHE);
  const keys = await cache.keys();
  if (keys.length <= MEDIA_CACHE_MAX_ENTRIES) return;
  // Cache API preserves insertion order, so the oldest entries come first.
  for (const request of keys.slice(0, keys.length - MEDIA_CACHE_MAX_ENTRIES)) {
    await cache.delete(request);
  }
}

/**
 * Network-first with a cached fallback for the app shell.
 *
 * A successful navigation response is stored so the last visited page can be
 * reopened offline. Only basic GET responses for documents are stored — storing
 * every redirect or error page would overwrite a good copy with a bad one.
 */
async function handleNavigation(event) {
  try {
    const response = await fetch(event.request);
    if (response && response.ok && response.type === 'basic') {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(event.request, response.clone()).catch(() => {});
    }
    return response;
  } catch (error) {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(event.request);
    if (cached) return cached;
    // Fall back to the site root, which is also the catalog page.
    const root = await cache.match('/');
    if (root) return root;
    throw error;
  }
}

/**
 * Cache-first for media, with a network fill (non-range requests).
 *
 * Cache-first is correct here: a media URL is content-addressed by the file it
 * names, and the upstream archive does not rewrite an episode in place.
 */
async function handleMedia(event) {
  const cache = await caches.open(MEDIA_CACHE);
  const cached = await cache.match(event.request.url, { ignoreVary: true });
  if (cached) return cached;

  const response = await fetch(event.request);
  // `response.status === 200` excludes 206 range replies, and `response.ok`
  // alone is not enough because 206 is also "ok".
  if (response.status === 200) {
    cache.put(event.request.url, response.clone()).then(trimMediaCache).catch(() => {});
  }
  return response;
}

/**
 * Parses a single `bytes=` range against a known size.
 * Returns {start,end}, 'unsatisfiable', or null (absent / multi-range / junk).
 */
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(header || '').trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!(suffix > 0) || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  if (start >= size) return 'unsatisfiable';
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return null;
  return { start, end };
}

/** Builds the 206 (or 416) a media element expects, from a cached full body. */
async function rangeFromCached(cached, rangeHeader) {
  const blob = await cached.blob();
  const size = blob.size;
  const type = cached.headers.get('content-type') || 'application/octet-stream';
  const range = parseRange(rangeHeader, size);
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  if (!range) {
    return new Response(blob, {
      status: 200,
      headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' }
    });
  }
  return new Response(blob.slice(range.start, range.end + 1), {
    status: 206,
    headers: {
      'Content-Type': type,
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      'Content-Length': String(range.end - range.start + 1),
      'Accept-Ranges': 'bytes'
    }
  });
}

/** URLs currently being downloaded in full for the offline cache. */
const fillsInFlight = new Set();

/** True when the user asked the browser to conserve data. */
function saveDataRequested() {
  try {
    return Boolean(self.navigator && self.navigator.connection && self.navigator.connection.saveData);
  } catch {
    return false;
  }
}

/** Total entity size from a `Content-Range: bytes a-b/total` header, or NaN. */
function totalFromContentRange(value) {
  const m = /\/(\d+)\s*$/.exec(String(value || ''));
  return m ? Number(m[1]) : NaN;
}

/**
 * Downloads one complete copy (no Range) and stores it if it is a full 200.
 *
 * This is the half that was missing: media elements ALWAYS send `Range`, so the
 * old worker passed every audio request straight through and the "listen again
 * offline" cache never received a single lecture. One fill runs at a time, only
 * for bounded audio/PDF sizes, and never under Save-Data.
 */
async function fillMediaCache(url) {
  if (fillsInFlight.has(url) || fillsInFlight.size >= MEDIA_FILL_MAX_CONCURRENT) return;
  fillsInFlight.add(url);
  try {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (response.status !== 200) return;
    const cache = await caches.open(MEDIA_CACHE);
    await cache.put(url, response);
    await trimMediaCache();
  } catch {
    // Offline or quota exceeded: the next play simply tries again.
  } finally {
    fillsInFlight.delete(url);
  }
}

/** Range requests: serve from a cached full copy, otherwise network + background fill. */
async function handleRangedMedia(event, fillable) {
  const request = event.request;
  const cache = await caches.open(MEDIA_CACHE);
  const cached = await cache.match(request.url, { ignoreVary: true });
  if (cached) return rangeFromCached(cached, request.headers.get('range'));

  const response = await fetch(request);
  if (fillable && !saveDataRequested() && (response.status === 206 || response.status === 200)) {
    const total =
      response.status === 206
        ? totalFromContentRange(response.headers.get('content-range'))
        : Number(response.headers.get('content-length'));
    if (Number.isFinite(total) && total > 0 && total <= MEDIA_FILL_MAX_BYTES) {
      event.waitUntil(fillMediaCache(request.url));
    }
  }
  return response;
}

/**
 * The media file a request names, for both direct paths and proxy URLs.
 *
 * Audio and video go through `/api/proxy?path=…`; only PDFs use `?url=`. The
 * old check looked at `url` alone, so no audio request was ever recognised.
 */
function mediaNameFor(url) {
  if (url.pathname === '/api/proxy') {
    if (url.searchParams.get('action')) return '';
    const inner = url.searchParams.get('path') || url.searchParams.get('url') || '';
    return inner.split(/[?#]/)[0];
  }
  return url.pathname;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // Only same-origin traffic: proxying third-party requests through this worker
  // would cache content this site does not control.
  if (url.origin !== self.location.origin) return;

  // Never intercept the maintenance/admin surface — it must always be live.
  if (url.pathname.startsWith('/api/admin/') || url.pathname.startsWith('/api/scan') || url.pathname.startsWith('/api/health-check')) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }

  const name = mediaNameFor(url);
  if (!CACHEABLE_MEDIA.test(name)) return;

  if (request.headers.get('range')) {
    // A stored 206 would replay with silent gaps, so partial responses are never
    // put; ranges are cut from a complete cached copy instead.
    event.respondWith(handleRangedMedia(event, FILLABLE_MEDIA.test(name)));
    return;
  }
  event.respondWith(handleMedia(event));
});
