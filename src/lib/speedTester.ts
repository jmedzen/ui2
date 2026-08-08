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
 * Triggers background server pre-caching for a requested asset
 */
export function triggerBackgroundServerCache(pathOrUrl: string): void {
  try {
    const proxyPreloadUrl = pathOrUrl.startsWith('http')
      ? `/api/proxy?url=${encodeURIComponent(pathOrUrl)}&action=preload`
      : `/api/proxy?path=${encodeURIComponent(pathOrUrl)}&action=preload`;

    fetch(proxyPreloadUrl, { method: 'GET', cache: 'no-store' }).catch(() => {});
  } catch (e) {
    console.warn('Failed to trigger background server cache:', e);
  }
}

/**
 * Measures download speed chunk (256KB) for a target URL
 */
async function measureChunkSpeed(targetUrl: string): Promise<number> {
  const startTime = performance.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 sec timeout for probe

    const res = await fetch(targetUrl, {
      method: 'GET',
      headers: { Range: 'bytes=0-262143' }, // 256 KB probe chunk
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
 * ALWAYS triggers background server caching regardless of winner.
 */
export async function getOptimalMediaRoute(
  path: string,
  directUrl: string
): Promise<SpeedTestResult> {
  const proxyUrl = `/api/proxy?path=${encodeURIComponent(path)}`;

  // ALWAYS trigger server background cache as per user requirement
  triggerBackgroundServerCache(path);

  // Check client memory cache
  const cachedRoute = speedCache.get(path);
  if (cachedRoute && Date.now() - cachedRoute.timestamp < CACHE_TTL_MS) {
    return {
      route: cachedRoute.route,
      directSpeedKbps: 0,
      proxySpeedKbps: 0,
      activeUrl: cachedRoute.route === 'proxy' ? proxyUrl : directUrl
    };
  }

  // Run non-blocking parallel probe test
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
