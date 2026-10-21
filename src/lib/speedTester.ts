'use client';

export interface SpeedTestResult {
  route: 'direct' | 'proxy';
  directSpeedKbps: number;
  proxySpeedKbps: number;
  activeUrl: string;
}

const speedCache = new Map<string, { route: 'direct' | 'proxy'; timestamp: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 Minutes client route preference memory
const MAX_SPEED_CACHE_ENTRIES = 500; // Bound the route-preference memory

/** Probe budget: never buffer more than this many bytes while measuring speed. */
const PROBE_MAX_BYTES = 32 * 1024;
const PROBE_TIMEOUT_MS = 2000;

/**
 * Evicts expired entries, then trims the oldest insertions if still oversized.
 * The previous implementation only checked TTL on read and never removed
 * anything, so the map grew for the whole lifetime of the tab.
 */
function pruneSpeedCache(now: number) {
  for (const [key, entry] of speedCache.entries()) {
    if (now - entry.timestamp >= CACHE_TTL_MS) {
      speedCache.delete(key);
    }
  }
  while (speedCache.size > MAX_SPEED_CACHE_ENTRIES) {
    const oldest = speedCache.keys().next().value;
    if (oldest === undefined) break;
    speedCache.delete(oldest);
  }
}

function rememberRoute(path: string, route: 'direct' | 'proxy') {
  const now = Date.now();
  // Refresh insertion order so the trim below behaves as LRU.
  speedCache.delete(path);
  speedCache.set(path, { route, timestamp: now });
  if (speedCache.size > MAX_SPEED_CACHE_ENTRIES) {
    pruneSpeedCache(now);
  }
}

/**
 * Sanitizes path or URL to prevent double-encoding of /api/proxy
 */
export function cleanMediaPath(pathOrUrl: string): string {
  if (!pathOrUrl) return '';
  let result = pathOrUrl;
  while (result.includes('/api/proxy?path=') || result.includes('/api/proxy?url=')) {
    if (result.includes('/api/proxy?path=')) {
      const raw = result.split('/api/proxy?path=')[1];
      const val = raw.split('&')[0];
      try {
        result = decodeURIComponent(val);
      } catch {
        result = val;
      }
    } else if (result.includes('/api/proxy?url=')) {
      const raw = result.split('/api/proxy?url=')[1];
      const val = raw.split('&')[0];
      try {
        result = decodeURIComponent(val);
      } catch {
        result = val;
      }
    }
  }
  return result;
}

/**
 * Queries server cache status for a specific media file
 */
export async function fetchCacheStatus(pathOrUrl: string): Promise<boolean> {
  try {
    const cleanPath = cleanMediaPath(pathOrUrl);
    if (!cleanPath) return false;

    const proxyStatusUrl = cleanPath.startsWith('http')
      ? `/api/proxy?url=${encodeURIComponent(cleanPath)}&action=status`
      : `/api/proxy?path=${encodeURIComponent(cleanPath)}&action=status`;

    const res = await fetch(proxyStatusUrl, { method: 'GET', cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      return !!data.isCached;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Triggers background server pre-caching for a requested asset
 */
export function triggerBackgroundServerCache(pathOrUrl: string): void {
  try {
    const cleanPath = cleanMediaPath(pathOrUrl);
    if (!cleanPath) return;

    const proxyPreloadUrl = cleanPath.startsWith('http')
      ? `/api/proxy?url=${encodeURIComponent(cleanPath)}&action=preload`
      : `/api/proxy?path=${encodeURIComponent(cleanPath)}&action=preload`;

    // Preload is intentionally independent of admin login: ordinary playback
    // must be able to warm the cache. It is a state-changing POST so link
    // prefetchers and cross-site navigations cannot trigger disk writes; the
    // server authorizes same-origin browser requests (or an explicit
    // automation token for non-browser callers).
    fetch(proxyPreloadUrl, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store'
    }).catch(() => {});
  } catch (e) {
    console.warn('Failed to trigger background server cache:', e);
  }
}

/**
 * Measures download speed of a bounded probe chunk (~32KB).
 *
 * The body is read through a stream reader that is cancelled as soon as
 * PROBE_MAX_BYTES have arrived. Previously this used `res.blob()`, which
 * buffers the *entire* response: when an origin ignores the Range header and
 * answers 200 with a full video, the browser would pull the whole file into
 * memory. The abort timer is also kept armed until the read finishes, so a
 * stalled transfer cannot hang the probe forever.
 */
async function measureChunkSpeed(targetUrl: string): Promise<number> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const startTime = performance.now();

  try {
    const res = await fetch(targetUrl, {
      method: 'GET',
      headers: { Range: `bytes=0-${PROBE_MAX_BYTES - 1}` },
      signal: controller.signal,
      cache: 'no-store'
    });

    if (!res.ok && res.status !== 206) {
      // Release the error response body. Returning without reading or
      // cancelling it left the stream (and its buffers) alive until GC on every
      // failed probe — and a dead mirror 404s both the direct and proxy probes
      // on every track change.
      await res.body?.cancel().catch(() => {});
      return 0;
    }

    let received = 0;
    const reader = res.body?.getReader();
    if (!reader) {
      return 0;
    }
    try {
      while (received < PROBE_MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) received += value.byteLength;
      }
    } finally {
      // Release the connection instead of draining the remaining bytes.
      await reader.cancel().catch(() => {});
    }

    const durationSec = (performance.now() - startTime) / 1000;
    if (durationSec <= 0) return 1000;
    const speedKbps = (received / 1024) / durationSec;
    return speedKbps;
  } catch {
    return 0;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Evaluates optimal media route between direct Fayun.org and local server proxy.
 * If server already has local disk cache, instantly routes to local proxy (0ms).
 * Otherwise triggers background server caching and tests connection speed to pick the faster host.
 */
export async function getOptimalMediaRoute(
  rawPath: string,
  directUrl: string
): Promise<SpeedTestResult> {
  const path = cleanMediaPath(rawPath);
  const proxyUrl = `/api/proxy?path=${encodeURIComponent(path)}`;

  // 1. Always trigger server background cache to guarantee local disk copy
  triggerBackgroundServerCache(path);

  // 2. Check if file is ALREADY cached on web server disk
  try {
    const isCachedOnDisk = await fetchCacheStatus(path);
    if (isCachedOnDisk) {
      rememberRoute(path, 'proxy');
      return {
        route: 'proxy',
        directSpeedKbps: 0,
        proxySpeedKbps: 50000, // High-speed local disk stream
        activeUrl: proxyUrl
      };
    }
  } catch {}

  // 3. Check client memory cache if recently evaluated
  const now = Date.now();
  const cachedRoute = speedCache.get(path);
  if (cachedRoute && now - cachedRoute.timestamp < CACHE_TTL_MS) {
    // Promote to most-recently-used position
    speedCache.delete(path);
    speedCache.set(path, cachedRoute);
    return {
      route: cachedRoute.route,
      directSpeedKbps: 0,
      proxySpeedKbps: 0,
      activeUrl: cachedRoute.route === 'proxy' ? proxyUrl : directUrl
    };
  }

  // 4. Run non-blocking parallel probe test between direct fayun.org and web proxy
  try {
    const [directSpeed, proxySpeed] = await Promise.all([
      measureChunkSpeed(directUrl),
      measureChunkSpeed(proxyUrl)
    ]);

    // Prefer the proxy only when it is genuinely faster, or when the direct
    // origin is unreachable. A tie now favours direct, which keeps the web
    // server out of the data path when both paths perform equally.
    let winningRoute: 'direct' | 'proxy';
    if (directSpeed === 0 && proxySpeed === 0) {
      winningRoute = 'proxy';
    } else if (directSpeed === 0) {
      winningRoute = 'proxy';
    } else if (proxySpeed > directSpeed) {
      winningRoute = 'proxy';
    } else {
      winningRoute = 'direct';
    }

    rememberRoute(path, winningRoute);

    return {
      route: winningRoute,
      directSpeedKbps: Math.round(directSpeed),
      proxySpeedKbps: Math.round(proxySpeed),
      activeUrl: winningRoute === 'proxy' ? proxyUrl : directUrl
    };
  } catch {
    return {
      route: 'proxy',
      directSpeedKbps: 0,
      proxySpeedKbps: 0,
      activeUrl: proxyUrl
    };
  }
}
