import './helpers/isolated-media-cache';

import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import {
  getCacheFilePath,
  isCached,
  cacheRemoteMedia,
  getCacheDir,
  setMaxCacheableBytesForTest
} from '@/lib/serverMediaCache';

const dir = getCacheDir();
const SMALL_CAP = 64 * 1024;

// The per-file ceiling is read lazily, so it can be pinned to a small value
// without re-importing the module (which top-level await would require, and this
// test runner compiles to CJS).
setMaxCacheableBytesForTest(SMALL_CAP);

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

function cleanup(cachePath: string) {
  fs.rmSync(cachePath, { force: true });
  fs.rmSync(`${cachePath}.tmp`, { force: true });
}

// Regression: the size ceiling was only compared against the *declared*
// Content-Length. When the origin omitted that header, expectedSize was 0 so the
// check was skipped entirely, and a chunked or hostile response of unbounded
// size was streamed to disk and committed as a complete cache entry.
test('cache — oversized responses are refused or aborted', async (t) => {
  await t.test('a declared oversize body is refused before writing', async () => {
    const target = 'https://www.fayun.org/ftpadmin/media/__declared_big__.mp4';
    const cachePath = getCacheFilePath(target, 'mp4');
    cleanup(cachePath);

    const restore = stubFetch(
      () =>
        new Response(Buffer.alloc(1024), {
          status: 200,
          headers: { 'content-type': 'video/mp4', 'content-length': String(SMALL_CAP * 16) }
        })
    );
    try {
      await cacheRemoteMedia(target, cachePath);
      assert.strictEqual(isCached(cachePath), false, 'a declared oversized asset must not be cached');
      assert.strictEqual(fs.existsSync(`${cachePath}.tmp`), false, 'no temp file may be left behind');
    } finally {
      restore();
      cleanup(cachePath);
    }
  });

  await t.test('an undeclared oversize stream is aborted mid-transfer', async () => {
    const target = 'https://www.fayun.org/ftpadmin/media/__chunked_big__.mp4';
    const cachePath = getCacheFilePath(target, 'mp4');
    cleanup(cachePath);

    // No Content-Length: only the streaming limiter can stop this.
    const restore = stubFetch(
      () =>
        new Response(Buffer.alloc(SMALL_CAP * 8), {
          status: 200,
          headers: { 'content-type': 'video/mp4' }
        })
    );
    try {
      await cacheRemoteMedia(target, cachePath);
      assert.strictEqual(isCached(cachePath), false, 'an unbounded stream must not be committed to cache');
      assert.strictEqual(fs.existsSync(`${cachePath}.tmp`), false, 'the partial temp file must be cleaned up');
    } finally {
      restore();
      cleanup(cachePath);
    }
  });

  await t.test('a body within the ceiling still caches', async () => {
    const target = 'https://www.fayun.org/ftpadmin/media/__small_ok__.mp4';
    const cachePath = getCacheFilePath(target, 'mp4');
    cleanup(cachePath);

    const restore = stubFetch(
      () =>
        new Response(Buffer.alloc(1024), {
          status: 200,
          headers: { 'content-type': 'video/mp4' }
        })
    );
    try {
      await cacheRemoteMedia(target, cachePath);
      assert.strictEqual(isCached(cachePath), true, 'a normal body must still cache');
    } finally {
      restore();
      cleanup(cachePath);
    }
  });

  await t.test('no oversized residue is left in the cache directory', () => {
    const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith('__') || f.endsWith('.tmp'));
    assert.deepStrictEqual(leftovers, [], `unexpected cache residue: ${leftovers.join(', ')}`);
  });

  t.after(() => setMaxCacheableBytesForTest(null));
});
