'use client';

export interface SpeedTestResult {
  route: 'direct' | 'proxy';
  directSpeedKbps: number;
  proxySpeedKbps: number;
  activeUrl: string;
}

const speedCache = new Map<string, { route: 'direct' | 'proxy'; timestamp: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 Minutes client route preference memory

/**
 * Sanitizes path or URL to prevent double-encoding of /api/proxy
 */
export function cleanMediaPath(pathOrUrl: string): string {
  if (!pathOrUrl) return '';
  if (pathOrUrl.includes('/api/proxy?path=')) {
    const raw = pathOrUrl.split('/api/proxy?path=')[1];
    return decodeURIComponent(raw.split('&')[0]);
  }
  if (pathOrUrl.includes('/api/proxy?url=')) {
    const raw = pathOrUrl.split('/api/proxy?url=')[1];
    return decodeURIComponent(raw.split('&')[0]);
  }
  return pathOrUrl;
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

    fetch(proxyPreloadUrl, { method: 'GET', cache: 'no-store' }).catch(() => {});
  } catch (e) {
    console.warn('Failed to trigger background server cache:', e);
  }
}

/**
 * Measures download speed chunk (32KB lightweight probe) for a target URL
 */
async function measureChunkSpeed(targetUrl: string): Promise<number> {
  const startTime = performance.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000); // 2 sec timeout for probe

    const res = await fetch(targetUrl, {
      method: 'GET',
      headers: { Range: 'bytes=0-32767' }, // 32 KB lightweight probe chunk
      signal: controller.signal,
      cache: 'no-store'
    });

    clearTimeout(timeoutId);

    if (!res.ok && res.status !== 206) {
      return 0;
    }

    const blob = await res.blob();
    const durationSec = (performance.now() - startTime) / 1000;

    if (durationSec <= 0) return 1000;
    const speedKbps = (blob.size / 1024) / durationSec;
    return speedKbps;
  } catch {
    return 0;
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
      speedCache.set(path, { route: 'proxy', timestamp: Date.now() });
      return {
        route: 'proxy',
        directSpeedKbps: 0,
        proxySpeedKbps: 50000, // High-speed local disk stream
        activeUrl: proxyUrl
      };
    }
  } catch {}

  // 3. Check client memory cache if recently evaluated
  const cachedRoute = speedCache.get(path);
  if (cachedRoute && Date.now() - cachedRoute.timestamp < CACHE_TTL_MS) {
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

    // If proxy speed is faster or equal, or direct failed, choose proxy
    const winningRoute: 'direct' | 'proxy' =
      proxySpeed >= directSpeed || directSpeed === 0 ? 'proxy' : 'direct';

    speedCache.set(path, { route: winningRoute, timestamp: Date.now() });

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
