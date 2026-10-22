
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
 *    truncated body produces silent gaps.
 */

const SHELL_CACHE = 'fayun-shell-v1';
const MEDIA_CACHE = 'fayun-media-v1';
const MEDIA_CACHE_MAX_ENTRIES = 60;
/** Only media that has been fully fetched is worth keeping. */
const CACHEABLE_MEDIA = /\.(mp3|m4a|aac|ogg|wav|mp4|m4v|webm|pdf)$/i;

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
 * Cache-first for media, with a network fill.
 *
 * Cache-first is correct here: a media URL is content-addressed by the file it
 * names, and the upstream archive does not rewrite an episode in place.
 */
async function handleMedia(event) {
  const cache = await caches.open(MEDIA_CACHE);
  const cached = await cache.match(event.request);
  if (cached) return cached;

  const response = await fetch(event.request);
  // `response.status === 200` excludes 206 range replies, and `response.ok`
  // alone is not enough because 206 is also "ok".
  if (response.status === 200 && CACHEABLE_MEDIA.test(new URL(event.request.url).pathname)) {
    cache.put(event.request, response.clone()).then(trimMediaCache).catch(() => {});
  }
  return response;
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

  const isMedia =
    CACHEABLE_MEDIA.test(url.pathname) ||
    (url.pathname === '/api/proxy' && CACHEABLE_MEDIA.test(url.searchParams.get('url') || ''));
  if (isMedia) {
    // Range requests carry a `Range` header and expect a 206; serving them from
    // a cached full body is handled by the browser, not here, so let the media
    // element's range traffic go to the network untouched.
    if (request.headers.get('range')) return;
    event.respondWith(handleMedia(event));
  }
});
