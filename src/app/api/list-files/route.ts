import { NextResponse } from 'next/server';

// Server-side In-Memory Cache (TTL: 1 Hour)
interface CacheEntry {
  data: any;
  timestamp: number;
}

const fileListCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

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
    const cached = fileListCache.get(src);
    if (cached && now - cached.timestamp < CACHE_TTL_MS) {
      return NextResponse.json(cached.data, {
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
      return NextResponse.json({ error: `Remote returned ${res.status}` }, { status: res.status });
    }

    const data = await res.json();

    // Cache successful responses
    if (data && data.status) {
      fileListCache.set(src, { data, timestamp: now });
    }

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
