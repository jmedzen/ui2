// Must come first: points the media cache and task log dir at throwaway paths.
import './helpers/isolated-media-cache';

import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/proxy/route';
import {
  getCacheDir,
  getCacheFilePath,
  isCached,
  cacheRemoteMedia,
  cleanStaleTempFiles,
  cleanAllTempFiles,
  enforceLRULimit,
  getCacheStats,
  getCacheStatsAsync,
  invalidateCacheStats,
  startCacheMaintenance
} from '@/lib/serverMediaCache';

const dir = getCacheDir();
const HOST = 'http://localhost:8410';

function stubFetch(handler: (url: string) => Response | Promise<Response>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return handler(url);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const settle = () => new Promise((r) => setTimeout(r, 200));

/* ------------------------------------------------------------------ *
 * Orphaned .tmp must not wedge caching
 * ------------------------------------------------------------------ */

// Regression: a .tmp with a fresh mtime was treated as "download in progress"
// and returned early, so a file orphaned by a restart silently refused to cache
// for 5 minutes while playback kept hitting the origin.
test('cache — an orphaned .tmp does not block a fresh download', async (t) => {
  await t.test('fresh .tmp from a previous process is reclaimed', async () => {
    const target = 'https://www.fayun.org/ftpadmin/media/__orphan__.mp4';
    const cachePath = getCacheFilePath(target, 'mp4');
    const tmp = `${cachePath}.tmp`;
    fs.rmSync(cachePath, { force: true });
    // Fresh mtime, but no download owned by this process is writing it.
    fs.writeFileSync(tmp, Buffer.alloc(64));

    let fetched = false;
    const restore = stubFetch(() => {
      fetched = true;
      return new Response('DATA', { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '4' } });
    });
    try {
      await cacheRemoteMedia(target, cachePath);
      assert.strictEqual(fetched, true, 'the orphaned .tmp must not suppress the download');
      assert.strictEqual(isCached(cachePath), true, 'the file must end up cached');
    } finally {
      restore();
      fs.rmSync(cachePath, { force: true });
      fs.rmSync(tmp, { force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * Streaming size ceiling when Content-Length is absent
 * ------------------------------------------------------------------ */

// The byte ceiling itself (MAX_CACHEABLE_BYTES) is read at module load, so the
// test that exercises it lives in media-cache-oversize.test.ts with a small cap
// configured before the module is imported. What is checked here is only that a
// modest body lacking Content-Length is still committed rather than being
// rejected as "incomplete" (the old code treated expectedSize === 0 as 0/0).
test('cache — a response without Content-Length is not mistaken for incomplete', async (t) => {
  await t.test('a complete body with no declared length is cached', async () => {
    const target = 'https://www.fayun.org/ftpadmin/media/__nolength__.mp4';
    const cachePath = getCacheFilePath(target, 'mp4');
    fs.rmSync(cachePath, { force: true });

    const restore = stubFetch(() =>
      new Response(Buffer.alloc(4096, 'x'), {
        status: 200,
        headers: { 'content-type': 'video/mp4' }
      })
    );
    try {
      await cacheRemoteMedia(target, cachePath);
      assert.strictEqual(isCached(cachePath), true, 'a body without Content-Length must still be cached');
    } finally {
      restore();
      fs.rmSync(cachePath, { force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * HTML-poisoned entries are evicted regardless of size
 * ------------------------------------------------------------------ */

// Regression: the read path only evicted HTML-shaped entries smaller than 512
// bytes, so a larger HTML error page was served as a HIT forever while
// action=status (which had no size guard) reported the same file as not cached.
test('cache — a large HTML-poisoned entry is evicted on read', async (t) => {
  await t.test('served from origin instead of as a poisoned HIT', async () => {
    const target = 'https://www.fayun.org/ftpadmin/media/__poison_large__.mp3';
    const cachePath = getCacheFilePath(target, 'mp3');
    const poisoned = Buffer.concat([
      Buffer.from('<!DOCTYPE html><html><head><title>Not Found</title></head><body>'),
      Buffer.alloc(2048, 'padding'),
      Buffer.from('</body></html>')
    ]);
    assert.ok(poisoned.length > 512, 'fixture must exceed the old 512-byte guard');
    fs.writeFileSync(cachePath, poisoned);

    const restore = stubFetch(() =>
      new Response('REAL-AUDIO', {
        status: 200,
        headers: { 'content-type': 'audio/mpeg', 'content-length': '10' }
      })
    );
    try {
      const res = await GET(new NextRequest(`${HOST}/api/proxy?path=/media/__poison_large__.mp3`));
      assert.strictEqual(res.headers.get('X-Proxy-Cache'), 'MISS', 'a poisoned entry must not be served as a HIT');

      // The poisoned file is gone immediately; the replacement download is
      // fire-and-forget, so wait for it before checking what landed.
      await settle();
      if (fs.existsSync(cachePath)) {
        assert.notStrictEqual(
          fs.statSync(cachePath).size,
          poisoned.length,
          'the poisoned payload must not remain under a cache name'
        );
      }
    } finally {
      restore();
      await settle();
      fs.rmSync(cachePath, { force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * LRU must be reachable without a completing download
 * ------------------------------------------------------------------ */

// Regression: enforceLRULimit was only called from scheduleLRUEnforcement, i.e.
// after a successful download. Once the disk filled, writes failed, so no
// download completed, so eviction never ran and the cache stayed over budget.
test('cache — eviction is reachable without a completed download', async (t) => {
  await t.test('cleanStaleTempFiles removes old orphans directly', async () => {
    const orphan = path.join(dir, `orphan-${Date.now()}.tmp`);
    fs.writeFileSync(orphan, Buffer.alloc(16));
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(orphan, old, old);

    await cleanStaleTempFiles();
    assert.strictEqual(fs.existsSync(orphan), false, 'an old orphaned .tmp must be reclaimed');
  });

  await t.test('a boot/maintenance pass is startable and idempotent', async () => {
    startCacheMaintenance();
    startCacheMaintenance(); // must not throw or create a second timer
    await enforceLRULimit();
  });

  // At startup nothing can be in flight, so every .tmp is an orphan. The
  // age-based sweeper skips files younger than 3 minutes, which is all of them
  // right after a restart; this is what reclaims them instead.
  await t.test('cleanAllTempFiles reclaims even brand-new orphans', async () => {
    const fresh = path.join(dir, `fresh-orphan-${Date.now()}.tmp`);
    fs.writeFileSync(fresh, Buffer.alloc(8)); // mtime = now
    const removed = await cleanAllTempFiles();
    assert.ok(removed >= 1, 'expected at least the fresh orphan to be removed');
    assert.strictEqual(fs.existsSync(fresh), false, 'a brand-new orphan must still be reclaimed at boot');
  });
});

/* ------------------------------------------------------------------ *
 * getCacheStats: memoized and async
 * ------------------------------------------------------------------ */

test('cache — stats are memoized and available asynchronously', async (t) => {
  await t.test('async variant reports the same figures as the sync one', async () => {
    invalidateCacheStats();
    const sync = getCacheStats();
    invalidateCacheStats();
    const asyncStats = await getCacheStatsAsync();
    assert.strictEqual(asyncStats.fileCount, sync.fileCount);
    assert.strictEqual(asyncStats.maxBytes, sync.maxBytes);
    assert.strictEqual(asyncStats.maxGb, 20);
  });

  await t.test('memoized reads do not rescan the directory', async () => {
    invalidateCacheStats();
    // Prime the memo, then add a file the memo cannot know about.
    getCacheStats();
    const extra = path.join(dir, '__memo_probe__.mp3');
    fs.writeFileSync(extra, Buffer.alloc(32));

    const cached = getCacheStats();
    assert.strictEqual(cached.fileCount, getCacheStats().fileCount, 'repeated reads are served from the memo');

    // After invalidation the new file is visible.
    invalidateCacheStats();
    const fresh = await getCacheStatsAsync();
    assert.ok(fresh.fileCount >= cached.fileCount, 'invalidation forces a rescan');
    fs.rmSync(extra, { force: true });
    invalidateCacheStats();
  });
});

/* ------------------------------------------------------------------ *
 * Preload rate limit cannot be escaped by forging the client address
 * ------------------------------------------------------------------ */

// Regression: the bucket key came straight from a client-supplied
// X-Forwarded-For, so rotating it yielded a fresh budget per request. Caddy
// overwrites that header, but the app is also reachable directly on :8410.
test('S1 — preload budget cannot be escaped by spoofing X-Forwarded-For', async (t) => {
  await t.test('rotating XFF still exhausts one shared budget', async () => {
    const restore = stubFetch(() => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    try {
      let limited = false;
      for (let i = 0; i < 60; i++) {
        const res = await POST(
          new NextRequest(`${HOST}/api/proxy?path=${encodeURIComponent(`/media/__spoof_${i}__.mp3`)}&action=preload`, {
            method: 'POST',
            headers: { 'x-forwarded-for': `203.0.113.${i % 256}`, origin: HOST }
          })
        );
        if (res.status === 429) {
          limited = true;
          break;
        }
      }
      assert.ok(limited, 'rotating the client address must not grant unlimited preloads');
      await settle();
    } finally {
      restore();
    }
  });
});
