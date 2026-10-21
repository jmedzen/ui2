// Must come first: points MEDIA_CACHE_DIR at a throwaway directory before the
// route handler (and therefore serverMediaCache) is evaluated.
import './helpers/isolated-media-cache';

import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/proxy/route';
import { ensureCacheDir, getCacheFilePath } from '@/lib/serverMediaCache';

const HOST = 'http://localhost:8410';

/**
 * Installs a fake global fetch so these tests never touch the network.
 * Returns a restore function.
 */
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

/**
 * A non-cacheable upstream answer. Background caching refuses HTML documents,
 * so this keeps fire-and-forget downloads from writing files or outliving the
 * test with a stubbed fetch.
 */
const htmlUpstream = () =>
  new Response('<html></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=UTF-8' }
  });

/** Waits for fire-and-forget background work to settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

/* ------------------------------------------------------------------ *
 * S2: upstream protocol / port pinning
 * ------------------------------------------------------------------ */

test('S2 — upstream allowlist pins protocol and port', async (t) => {
  await t.test('rejects non-default ports on an allowlisted host', async () => {
    // Regression: the hostname check ignored the port, so the proxy would
    // happily attempt connections to :22 / :6379 / :9200 / :2375.
    for (const port of ['22', '6379', '9200', '2375', '8080']) {
      const target = encodeURIComponent(`https://www.fayun.org:${port}/x.mp3`);
      const res = await GET(new NextRequest(`${HOST}/api/proxy?url=${target}`));
      assert.strictEqual(res.status, 403, `Port ${port} must be rejected`);
    }
  });

  await t.test('accepts the default HTTPS port, explicit or implicit', async () => {
    const restore = stubFetch(htmlUpstream);
    try {
      for (const host of ['https://www.fayun.org/x.mp3', 'https://www.fayun.org:443/x.mp3']) {
        const target = encodeURIComponent(host);
        const res = await GET(new NextRequest(`${HOST}/api/proxy?url=${target}&action=status`));
        assert.strictEqual(res.status, 200, `${host} must be accepted`);
      }
    } finally {
      restore();
    }
  });

  await t.test('rejects non-HTTPS upstreams', async () => {
    const target = encodeURIComponent('http://www.fayun.org/x.mp3');
    const res = await GET(new NextRequest(`${HOST}/api/proxy?url=${target}`));
    assert.strictEqual(res.status, 403, 'Plain HTTP upstream must be rejected');
  });

  await t.test('still blocks off-allowlist hosts and userinfo tricks', async () => {
    for (const host of [
      'https://evil.com/x.mp3',
      'https://www.fayun.org@evil.com/x.mp3',
      'https://www.fayun.org.evil.com/x.mp3'
    ]) {
      const target = encodeURIComponent(host);
      const res = await GET(new NextRequest(`${HOST}/api/proxy?url=${target}`));
      assert.strictEqual(res.status, 403, `${host} must be rejected`);
    }
  });
});

/* ------------------------------------------------------------------ *
 * S1: preload authorization and rate limiting
 * ------------------------------------------------------------------ */

test('S1 — preload is authorized and rate limited', async (t) => {
  await t.test('GET preload is rejected with 405 and Allow: POST', async () => {
    // A state-changing cache write must not be triggerable by a link, image or
    // prefetch. Ordinary playback still uses GET.
    const req = new NextRequest(`${HOST}/api/proxy?path=/media/audio/x.mp3&action=preload`, {
      headers: { origin: HOST }
    });
    const res = await GET(req);
    assert.strictEqual(res.status, 405);
    assert.strictEqual(res.headers.get('allow'), 'POST');
  });

  await t.test('rejects cross-site preload triggers', async () => {
    const req = new NextRequest(`${HOST}/api/proxy?path=/media/audio/x.mp3&action=preload`, {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site' }
    });
    const res = await POST(req);
    assert.strictEqual(res.status, 403, 'Cross-site preload must be rejected');
  });

  await t.test('rejects an unauthenticated preload trigger', async () => {
    // A preload writes to cache disk, so it now requires the task token.
    // Regression: an anonymous caller could drive unbounded disk writes.
    const req = new NextRequest(`${HOST}/api/proxy?path=/media/audio/x.mp3&action=preload`, {
      method: 'POST',
      headers: { origin: 'https://evil.example.com' }
    });
    const res = await POST(req);
    assert.strictEqual(res.status, 401, 'An unauthenticated preload must be rejected');
  });

  await t.test('accepts a same-origin preload trigger', async () => {
    const restore = stubFetch(htmlUpstream);
    try {
      const req = new NextRequest(`${HOST}/api/proxy?path=/media/audio/__auth_ok__.mp3&action=preload`, {
        method: 'POST',
        headers: { origin: HOST }
      });
      const res = await POST(req);
      assert.strictEqual(res.status, 200, 'A same-origin preload must be accepted');
      await settle();
    } finally {
      restore();
    }
  });

  await t.test('enforces a per-client preload budget', async () => {
    const restore = stubFetch(htmlUpstream);
    try {
      // Same-origin requests are authorized, so the limiter is what stops a burst.
      let sawLimited = false;
      for (let i = 0; i < 40; i++) {
        const req = new NextRequest(
          `${HOST}/api/proxy?path=${encodeURIComponent(`/media/__rl_${i}__.mp3`)}&action=preload`,
          { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.77', origin: HOST } }
        );
        const res = await POST(req);
        if (res.status === 429) {
          sawLimited = true;
          assert.strictEqual(res.headers.get('retry-after'), '60');
          break;
        }
        assert.strictEqual(res.status, 200);
      }
      assert.ok(sawLimited, 'Burst of preload requests must eventually be rate limited');
      // Let the fire-and-forget downloads finish while the stub is still active.
      await settle();
    } finally {
      restore();
    }
  });
});

/* ------------------------------------------------------------------ *
 * S3: response hardening
 * ------------------------------------------------------------------ */

test('S3 — proxied responses are hardened', async (t) => {
  ensureCacheDir();
  const remotePath = '/media/__s3_fixture__/clip.mp3';
  const filePath = getCacheFilePath(`https://www.fayun.org/ftpadmin${remotePath}`, 'mp3');
  fs.writeFileSync(filePath, Buffer.alloc(2048, 0x41));

  const evilPath = '/media/__s3_fixture__/evil.svg';
  const evilFile = getCacheFilePath(`https://www.fayun.org/ftpadmin${evilPath}`, 'svg');

  t.after(() => {
    for (const p of [filePath, evilFile]) {
      try {
        fs.unlinkSync(p);
      } catch {}
    }
  });

  await t.test('cache HIT carries nosniff and inline disposition', async () => {
    const res = await GET(new NextRequest(`${HOST}/api/proxy?path=${encodeURIComponent(remotePath)}`));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(res.headers.get('cross-origin-resource-policy'), 'same-origin');
    // Audio must stay inline: the players rely on it, and a sandboxed CSP would
    // stop the browser rendering the media.
    assert.strictEqual(res.headers.get('content-disposition'), 'inline');
    assert.strictEqual(res.headers.get('content-security-policy'), null);
    // Drain the stream: the fixture is unlinked in t.after and an unread
    // file stream would raise ENOENT after the test has already finished.
    assert.strictEqual((await res.arrayBuffer()).byteLength, 2048);
  });

  await t.test('security headers are present on partial responses too', async () => {
    const req = new NextRequest(`${HOST}/api/proxy?path=${encodeURIComponent(remotePath)}`, {
      headers: { Range: 'bytes=0-99' }
    });
    const res = await GET(req);
    assert.strictEqual(res.status, 206);
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(res.headers.get('content-disposition'), 'inline');
    assert.strictEqual((await res.arrayBuffer()).byteLength, 100);
  });

  await t.test('upstream active documents are rejected, not reflected', async () => {
    // Regression: only text/html was blocked, so an upstream SVG would have been
    // served as image/svg+xml in the application's own origin (script execution).
    const restore = stubFetch(
      () =>
        new Response('<svg onload="alert(1)"/>', {
          status: 200,
          headers: { 'content-type': 'image/svg+xml' }
        })
    );
    try {
      const res = await GET(new NextRequest(`${HOST}/api/proxy?path=${encodeURIComponent(evilPath)}`));
      assert.strictEqual(res.status, 404, 'SVG payload must be rejected');
      assert.notStrictEqual(res.headers.get('content-type'), 'image/svg+xml');
    } finally {
      restore();
    }
  });

  await t.test('html and xml upstreams are rejected as well', async () => {
    for (const ct of ['text/html', 'application/xhtml+xml', 'text/xml', 'application/xml']) {
      const restore = stubFetch(() => new Response('<x/>', { status: 200, headers: { 'content-type': ct } }));
      try {
        const res = await GET(new NextRequest(`${HOST}/api/proxy?path=${encodeURIComponent(evilPath)}`));
        assert.strictEqual(res.status, 404, `${ct} must be rejected`);
      } finally {
        restore();
      }
    }
  });

  await t.test('PDFs are served inline so the viewer renders them', async () => {
    // Regression: PDFs were forced to `attachment`, which made lecture notes
    // download instead of displaying in the in-page iframe.
    const restore = stubFetch(
      () =>
        new Response('%PDF-1.4', {
          status: 200,
          headers: { 'content-type': 'application/pdf' }
        })
    );
    try {
      const res = await GET(new NextRequest(`${HOST}/api/proxy?path=${encodeURIComponent('/media/__s3_fixture__/doc.pdf')}`));
      assert.strictEqual(res.headers.get('content-disposition'), 'inline');
      // A CSP `sandbox` would stop the built-in PDF viewer from loading.
      assert.strictEqual(res.headers.get('content-security-policy'), null);
      await res.arrayBuffer();
      await settle();
    } finally {
      restore();
    }
  });

  await t.test('genuinely non-media payloads are still forced to download', async () => {
    const restore = stubFetch(
      () =>
        new Response('binary', {
          status: 200,
          headers: { 'content-type': 'application/zip' }
        })
    );
    try {
      const res = await GET(new NextRequest(`${HOST}/api/proxy?path=${encodeURIComponent('/media/__s3_fixture__/bundle.zip')}`));
      assert.strictEqual(res.headers.get('content-disposition'), 'attachment');
      assert.match(res.headers.get('content-security-policy') || '', /default-src 'none'/);
      await res.arrayBuffer();
      await settle();
    } finally {
      restore();
    }
  });
});

/* ------------------------------------------------------------------ *
 * S1: background download concurrency ceiling
 * ------------------------------------------------------------------ */

test('S1 — background downloads are concurrency capped', async (t) => {
  const { getMaxConcurrentDownloads, getActiveDownloadCount, getQueuedDownloadCount, cacheRemoteMedia } =
    await import('@/lib/serverMediaCache');

  await t.test('cap is a small positive integer', () => {
    const cap = getMaxConcurrentDownloads();
    assert.ok(cap >= 1 && cap <= 16, `unexpected concurrency cap: ${cap}`);
  });

  await t.test('never exceeds the cap under a burst of distinct targets', async () => {
    const cap = getMaxConcurrentDownloads();
    let seenPeak = 0;

    // Sample the slot counter on every timer tick while the burst runs; this
    // catches overshoot that a single probe inside fetch would miss.
    const sampler = setInterval(() => {
      seenPeak = Math.max(seenPeak, getActiveDownloadCount());
    }, 5);

    // Slow, HTML-shaped upstreams: they hold a download slot open but are then
    // refused by the cache, so no fixture files are written.
    const restore = stubFetch(
      async () => {
        await new Promise((r) => setTimeout(r, 60));
        return new Response('<html></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' }
        });
      }
    );

    try {
      const jobs: Promise<void>[] = [];
      for (let i = 0; i < cap * 4; i++) {
        jobs.push(
          cacheRemoteMedia(
            `https://www.fayun.org/ftpadmin/media/__cap_${i}__.mp3`,
            getCacheFilePath(`https://www.fayun.org/ftpadmin/media/__cap_${i}__.mp3`, 'mp3')
          )
        );
      }
      await Promise.all(jobs.map((p) => p.catch(() => undefined)));
      clearInterval(sampler);
      assert.ok(
        seenPeak <= cap,
        `observed ${seenPeak} concurrent transfers, cap is ${cap}`
      );
      assert.strictEqual(getActiveDownloadCount(), 0, 'all slots must be released');
      assert.strictEqual(getQueuedDownloadCount(), 0, 'queue must drain');
    } finally {
      clearInterval(sampler);
      restore();
    }
  });
});
