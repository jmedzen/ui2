import { NextResponse } from 'next/server';

/**
 * Shape of the upstream directory listing.
 *
 * The proxy forwards the remote service's JSON verbatim, so only the field this
 * route actually reads is declared; everything else stays `unknown` rather than
 * being trusted.
 */
interface UpstreamListing {
  status?: boolean;
  [key: string]: unknown;
}

// Server-side In-Memory LRU Cache (TTL: 1 Hour, Max Capacity: 300 entries)
interface CacheEntry {
  data: UpstreamListing;
  timestamp: number;
  ttl: number;
  status: number;
  /** Approximate retained size, so the cache can also be bounded by bytes. */
  bytes: number;
}

const fileListCache = new Map<string, CacheEntry>();
const POSITIVE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour for valid directory listings
const NEGATIVE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 mins for non-existent / empty directories
const MAX_CACHE_ITEMS = 300;

/**
 * Hard ceiling on the total approximate bytes this cache may retain.
 *
 * The entry cap alone was not a memory bound: every entry could hold a body up
 * to MAX_RESPONSE_BYTES, so 300 x 2 MB = ~600 MB was reachable — and this route
 * is unauthenticated and public, so any caller could mint distinct `src` values
 * to fill it. Byte accounting is approximate (the parsed object size is
 * estimated from the source text) but that is sufficient to bound growth.
 */
const MAX_CACHE_BYTES = Math.max(
  1024 * 1024,
  parseInt(process.env.LIST_FILES_CACHE_MAX_BYTES || '', 10) || 32 * 1024 * 1024
);

/** Upper bound on a single upstream directory listing we are willing to parse. */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 15000;

/** Running total of `entry.bytes`; kept in lockstep with every set/delete. */
let cacheBytes = 0;

function deleteEntry(key: string): void {
  const entry = fileListCache.get(key);
  if (!entry) return;
  cacheBytes -= entry.bytes;
  fileListCache.delete(key);
  if (cacheBytes < 0) cacheBytes = 0;
}

function putEntry(key: string, entry: CacheEntry): void {
  // Replacing a key must not double-count its bytes.
  if (fileListCache.has(key)) deleteEntry(key);
  fileListCache.set(key, entry);
  cacheBytes += entry.bytes;
}

function cleanExpiredCache(now: number) {
  if (fileListCache.size === 0) return;

  // Always drop expired entries: they are useless regardless of the caps, and
  // the previous version only looked when the map was already over the entry
  // cap, so an expired-but-under-cap cache kept stale data indefinitely.
  for (const [key, entry] of fileListCache.entries()) {
    if (now - entry.timestamp >= entry.ttl) deleteEntry(key);
  }

  // LRU eviction by insertion order until both caps are satisfied.
  while (fileListCache.size > MAX_CACHE_ITEMS || cacheBytes > MAX_CACHE_BYTES) {
    const firstKey = fileListCache.keys().next().value;
    if (firstKey === undefined) break;
    deleteEntry(firstKey);
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
      // LRU key promotion: delete + re-set moves the key to the newest position.
      // This bypasses putEntry/deleteEntry on purpose — the same entry (and thus
      // the same retained bytes) stays in the cache, so `cacheBytes` is
      // unchanged and must not be adjusted.
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
    } catch (e: unknown) {
      if (e instanceof Error && e.name === 'AbortError') {
        return NextResponse.json({ error: 'Upstream directory listing timed out' }, { status: 504 });
      }
      return NextResponse.json({ error: 'Upstream directory listing failed' }, { status: 502 });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      const errData = { error: `Remote returned ${res.status}` };
      // Negative cache 404/400 errors to prevent repeated hammering
      putEntry(src, {
        data: errData,
        timestamp: now,
        ttl: NEGATIVE_CACHE_TTL_MS,
        status: res.status,
        bytes: 256
      });
      return NextResponse.json(errData, { status: res.status });
    }

    // Read with a hard byte cap *while streaming*.
    //
    // `await res.text()` materialised the entire body before the size check ran,
    // so the cap only decided what to do after the memory had already been
    // spent: an upstream that answered with a large (or endless) body could
    // exhaust the server process. The reader now stops at the cap and cancels
    // the transfer, and a declared Content-Length is rejected up front so an
    // obviously oversized response is never read at all.
    const declaredLength = Number(res.headers.get('content-length') || '');
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      try {
        await res.body?.cancel();
      } catch {}
      return NextResponse.json({ error: 'Upstream directory listing too large' }, { status: 502 });
    }

    let text: string;
    const reader = res.body?.getReader();
    if (!reader) {
      // No stream available (older runtime): fall back, but still check Length.
      try {
        text = await res.text();
      } catch {
        return NextResponse.json({ error: 'Failed to read upstream response' }, { status: 502 });
      }
      if (Buffer.byteLength(text, 'utf-8') > MAX_RESPONSE_BYTES) {
        return NextResponse.json({ error: 'Upstream directory listing too large' }, { status: 502 });
      }
    } else {
      const chunks: Uint8Array[] = [];
      let total = 0;
      let overflowed = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          total += value.byteLength;
          if (total > MAX_RESPONSE_BYTES) {
            overflowed = true;
            break;
          }
          chunks.push(value);
        }
      } catch {
        try {
          await reader.cancel();
        } catch {}
        return NextResponse.json({ error: 'Failed to read upstream response' }, { status: 502 });
      }
      if (overflowed) {
        // Release the socket instead of draining the remaining bytes.
        try {
          await reader.cancel();
        } catch {}
        return NextResponse.json({ error: 'Upstream directory listing too large' }, { status: 502 });
      }
      text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf-8');
    }

    let data: UpstreamListing;
    try {
      data = JSON.parse(text) as UpstreamListing;
    } catch {
      return NextResponse.json({ error: 'Upstream returned malformed JSON' }, { status: 502 });
    }

    // Cache successful responses with standard TTL, empty with negative TTL.
    // `text.length` is the byte length of the source body (the body was decoded
    // from UTF-8, and the JSON we parsed came from exactly these bytes), so it
    // is a reasonable estimate of what the parsed object retains.
    const isSuccess = data && data.status;
    putEntry(src, {
      data,
      timestamp: now,
      ttl: isSuccess ? POSITIVE_CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS,
      status: 200,
      bytes: text.length
    });

    return NextResponse.json(data, {
      headers: {
        'X-Cache-Status': 'MISS',
        'Cache-Control': 'public, max-age=3600'
      }
    });
  } catch (error: unknown) {
    console.error('[API/ListFiles] Error:', error);
    return NextResponse.json({ error: 'Failed to list files' }, { status: 500 });
  }
}
