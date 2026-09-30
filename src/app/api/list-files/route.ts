import { NextResponse } from 'next/server';

// Server-side In-Memory LRU Cache (TTL: 1 Hour, Max Capacity: 200 entries)
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

function cleanExpiredCache(now: number) {
  for (const [key, entry] of fileListCache.entries()) {
    if (now - entry.timestamp >= entry.ttl) {
      fileListCache.delete(key);
    }
  }
  // LRU Eviction: If still exceeds max capacity, delete oldest insertion
  while (fileListCache.size > MAX_CACHE_ITEMS) {
    const firstKey = fileListCache.keys().next().value;
    if (firstKey) fileListCache.delete(firstKey);
    else break;
  }
}

export async function POST(request: Request) {
  try {
    const { src } = await request.json();
    if (!src || typeof src !== 'string') {
      return NextResponse.json({ error: 'Missing or invalid src parameter' }, { status: 400 });
    }

    // Security Audit: Prevent Directory Traversal
    if (src.includes('..') || src.includes('\\')) {
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

    const res = await fetch('https://www.fayun.org/public/php/list.php', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      },
      body: JSON.stringify({ src }),
      cache: 'no-store'
    });

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

    const data = await res.json();

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
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
