import { NextResponse } from 'next/server';

// Server-side In-Memory LRU Cache (TTL: 1 Hour, Max Capacity: 300 entries)
interface CacheEntry {
  data: any;
  timestamp: number;
  ttl: number;
  status: number;
}

const fileListCache = new Map<string, CacheEntry>();
const POSITIVE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour for valid directory listings
const NEGATIVE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 mins for non-existent / empty directories
const MAX_CACHE_ITEMS = 300;

/** Upper bound on a single upstream directory listing we are willing to parse. */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 15000;

function cleanExpiredCache(now: number) {
  // Cheap early exit: nothing can be expired before the shortest TTL elapses
  // since the newest insertion, and the size check is O(1) when in bounds.
  if (fileListCache.size === 0) return;

  if (fileListCache.size > MAX_CACHE_ITEMS) {
    for (const [key, entry] of fileListCache.entries()) {
      if (now - entry.timestamp >= entry.ttl) {
        fileListCache.delete(key);
      }
    }
  }

  // LRU Eviction: If still exceeds max capacity, delete oldest insertion
  while (fileListCache.size > MAX_CACHE_ITEMS) {
    const firstKey = fileListCache.keys().next().value;
    if (firstKey === undefined) break;
    fileListCache.delete(firstKey);
  }
}

export async function POST(request: Request) {
  try {
    let src: unknown;
    try {
      ({ src } = await request.json());
    } catch {
      return NextResponse.json({ error: 'Malformed JSON body' }, { status: 400 });
    }

    if (!src || typeof src !== 'string') {
      return NextResponse.json({ error: 'Missing or invalid src parameter' }, { status: 400 });
    }

    // Security Audit: Prevent Directory Traversal
    if (src.includes('..') || src.includes('\\') || src.includes('\0')) {
      return NextResponse.json({ error: 'Forbidden: Invalid path sequence' }, { status: 400 });
    }

    const now = Date.now();
    cleanExpiredCache(now);

    const cached = fileListCache.get(src);
    if (cached && now - cached.timestamp < cached.ttl) {
      // LRU Key Promotion on Hit
      fileListCache.delete(src);
      fileListCache.set(src, cached);

      return NextResponse.json(cached.data, {
        status: cached.status || 200,
        headers: {
          'X-Cache-Status': 'HIT',
          'Cache-Control': 'public, max-age=3600'
        }
      });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch('https://www.fayun.org/public/php/list.php', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0'
        },
        body: JSON.stringify({ src }),
        cache: 'no-store',
        signal: controller.signal
      });
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        return NextResponse.json({ error: 'Upstream directory listing timed out' }, { status: 504 });
      }
      return NextResponse.json({ error: 'Upstream directory listing failed' }, { status: 502 });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      const errData = { error: `Remote returned ${res.status}` };
      // Negative cache 404/400 errors to prevent repeated hammering
      fileListCache.set(src, {
        data: errData,
        timestamp: now,
        ttl: NEGATIVE_CACHE_TTL_MS,
        status: res.status
      });
      return NextResponse.json(errData, { status: res.status });
    }

    // Read as text with a hard size cap before parsing, so an oversized or
    // non-JSON upstream body cannot exhaust memory or throw an opaque 500.
    let text: string;
    try {
      text = await res.text();
    } catch {
      return NextResponse.json({ error: 'Failed to read upstream response' }, { status: 502 });
    }

    if (text.length > MAX_RESPONSE_BYTES) {
      return NextResponse.json({ error: 'Upstream directory listing too large' }, { status: 502 });
    }

    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: 'Upstream returned malformed JSON' }, { status: 502 });
    }

    // Cache successful responses with standard TTL, empty with negative TTL
    const isSuccess = data && data.status;
    fileListCache.set(src, {
      data,
      timestamp: now,
      ttl: isSuccess ? POSITIVE_CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS,
      status: 200
    });

    return NextResponse.json(data, {
      headers: {
        'X-Cache-Status': 'MISS',
        'Cache-Control': 'public, max-age=3600'
      }
    });
  } catch (error: any) {
    console.error('[API/ListFiles] Error:', error);
    return NextResponse.json({ error: 'Failed to list files' }, { status: 500 });
  }
}
