// Must come first: points the media cache and task log dir at throwaway paths.
import './helpers/isolated-media-cache';

import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/proxy/route';
import {
  cacheRemoteMedia,
  getActiveDownloadCount,
  getCacheDir,
  getCacheFilePath,
  isCached
} from '@/lib/serverMediaCache';
import {
  checkUpstreamUrl,
  fetchUpstream,
  UpstreamPolicyError,
  UpstreamTimeoutError
} from '@/lib/upstream';

const HOST = 'http://localhost:8410';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

/** Replaces global fetch and records every URL it was asked for. */
function stubFetch(handler: Handler): { calls: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return handler(url, init);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const redirect = (location: string, status = 302) =>
  new Response(null, { status, headers: { location } });

/** Resolves only when the request's signal aborts, mimicking a dead origin. */
const neverAnswers = (init: RequestInit) =>
  new Promise<Response>((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });

function withEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test('upstream policy — checkUpstreamUrl', () => {
  assert.ok(checkUpstreamUrl('https://www.fayun.org/a.mp3').ok);
  assert.ok(checkUpstreamUrl('https://FAYUN.org:443/a.mp3').ok);
  const reasons: [string, string][] = [
    ['http://www.fayun.org/a.mp3', 'protocol'],
    ['https://evil.example/a.mp3', 'host'],
    ['https://www.fayun.org.evil.example/a.mp3', 'host'],
    ['https://www.fayun.org:8443/a.mp3', 'port'],
    ['https://user:pw@www.fayun.org/a.mp3', 'userinfo'],
    ['not a url', 'invalid']
  ];
  for (const [url, reason] of reasons) {
    const r = checkUpstreamUrl(url);
    assert.ok(!r.ok && r.reason === reason, `${url} must be rejected as ${reason}`);
  }
  // Relative Location headers resolve against the hop that issued them.
  const rel = checkUpstreamUrl('/b.mp3', 'https://www.fayun.org/dir/a.mp3');
  assert.ok(rel.ok && rel.url.href === 'https://www.fayun.org/b.mp3');
});

test('upstream redirects are validated hop by hop', async (t) => {
  await t.test('follows an allowlisted (relative) redirect', async () => {
    const { calls, restore } = stubFetch((url, init) => {
      assert.strictEqual(init.redirect, 'manual', 'redirects must never be auto-followed');
      if (url.endsWith('/old.mp3')) return redirect('/new.mp3', 301);
      return new Response('OK', { status: 200 });
    });
    try {
      const res = await fetchUpstream('https://www.fayun.org/old.mp3');
      assert.strictEqual(await res.text(), 'OK');
      assert.deepStrictEqual(calls, ['https://www.fayun.org/old.mp3', 'https://www.fayun.org/new.mp3']);
    } finally {
      restore();
    }
  });

  for (const [label, location] of [
    ['an external host', 'https://evil.example/x.mp3'],
    ['plain HTTP', 'http://www.fayun.org/x.mp3'],
    ['a non-standard port', 'https://www.fayun.org:6379/'],
    ['a link-local metadata address', 'http://169.254.169.254/latest/meta-data/']
  ]) {
    await t.test(`refuses a redirect to ${label} without contacting it`, async () => {
      const { calls, restore } = stubFetch(() => redirect(location));
      try {
        await assert.rejects(fetchUpstream('https://www.fayun.org/x.mp3'), UpstreamPolicyError);
        assert.strictEqual(calls.length, 1, 'the redirect target must never be fetched');
      } finally {
        restore();
      }
    });
  }

  await t.test('caps the redirect chain', async () => {
    const { calls, restore } = stubFetch((url) => redirect(`${url}x`));
    try {
      await assert.rejects(fetchUpstream('https://www.fayun.org/a', { maxRedirects: 3 }), /too many/);
      assert.strictEqual(calls.length, 4);
    } finally {
      restore();
    }
  });

  await t.test('303 turns a POST into a body-less GET', async () => {
    const seen: { method?: string; body?: unknown }[] = [];
    const { restore } = stubFetch((url, init) => {
      seen.push({ method: init.method, body: init.body });
      return url.endsWith('/list') ? redirect('/list2', 303) : new Response('{}');
    });
    try {
      await fetchUpstream('https://www.fayun.org/list', { method: 'POST', body: '{"a":1}' });
      assert.deepStrictEqual(seen, [{ method: 'POST', body: '{"a":1}' }, { method: 'GET', body: undefined }]);
    } finally {
      restore();
    }
  });
});

test('upstream timeouts', async (t) => {
  await t.test('headers that never arrive raise a headers timeout', async () => {
    const { restore } = stubFetch((_, init) => neverAnswers(init));
    try {
      const started = Date.now();
      await assert.rejects(
        fetchUpstream('https://www.fayun.org/x.mp3', { timeoutMs: 80 }),
        (e: unknown) => e instanceof UpstreamTimeoutError && e.phase === 'headers'
      );
      assert.ok(Date.now() - started < 2000);
    } finally {
      restore();
    }
  });

  await t.test('a body that stalls mid-transfer raises an idle timeout and aborts the request', async () => {
    let upstreamSignal: AbortSignal | undefined;
    const { restore } = stubFetch((_, init) => {
      upstreamSignal = init.signal ?? undefined;
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (!sent) {
            sent = true;
            c.enqueue(new Uint8Array([1, 2, 3]));
          }
          // Second pull: never enqueue — the origin went silent.
          return new Promise(() => {});
        }
      });
      return new Response(body, { status: 200 });
    });
    try {
      const res = await fetchUpstream('https://www.fayun.org/x.mp3', { idleTimeoutMs: 80 });
      await assert.rejects(res.arrayBuffer(), (e: unknown) => e instanceof UpstreamTimeoutError && e.phase === 'idle');
      assert.ok(upstreamSignal?.aborted, 'the stalled request must be aborted, not leaked');
    } finally {
      restore();
    }
  });

  await t.test('a consumer that pauses (backpressure) is not mistaken for a dead origin', async () => {
    const { restore } = stubFetch(() => {
      let n = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (n++ < 3) c.enqueue(new Uint8Array([n]));
          else c.close();
        }
      });
      return new Response(body, { status: 200 });
    });
    try {
      const res = await fetchUpstream('https://www.fayun.org/x.mp3', { idleTimeoutMs: 50 });
      await new Promise((r) => setTimeout(r, 200)); // paused for 4x the idle bound
      const bytes = new Uint8Array(await res.arrayBuffer());
      assert.deepStrictEqual([...bytes], [1, 2, 3]);
    } finally {
      restore();
    }
  });
});

test('proxy GET applies the upstream policy', async (t) => {
  await t.test('an off-allowlist redirect is a 502 and the target is never contacted', async () => {
    const { calls, restore } = stubFetch((url) =>
      url.includes('evil.example') ? new Response('PWNED', { status: 200, headers: { 'content-type': 'audio/mpeg' } }) : redirect('https://evil.example/secret')
    );
    try {
      const target = encodeURIComponent('https://www.fayun.org/ftpadmin/media/__redirect_evil__.mp3');
      const res = await GET(new NextRequest(`${HOST}/api/proxy?url=${target}`));
      assert.strictEqual(res.status, 502);
      assert.ok(!(await res.text()).includes('PWNED'));
      await new Promise((r) => setTimeout(r, 150)); // let the background download settle
      assert.ok(!calls.some((u) => u.includes('evil.example')), `evil host was fetched: ${calls.join(', ')}`);
      assert.ok(!isCached(getCacheFilePath('https://www.fayun.org/ftpadmin/media/__redirect_evil__.mp3', 'mp3')));
    } finally {
      restore();
    }
  });

  await t.test('a silent origin is a 504, not a hung request', async () => {
    await withEnv({ UPSTREAM_TIMEOUT_MS: '80' }, async () => {
      const { restore } = stubFetch((_, init) => neverAnswers(init));
      try {
        const res = await GET(new NextRequest(`${HOST}/api/proxy?path=${encodeURIComponent('/media/__silent__.mp3')}`));
        assert.strictEqual(res.status, 504);
        await new Promise((r) => setTimeout(r, 200));
      } finally {
        restore();
      }
    });
  });
});

test('background cache uses the same policy', async (t) => {
  await t.test('a redirect off the allowlist is not cached', async () => {
    const target = 'https://www.fayun.org/ftpadmin/media/__bg_redirect__.mp3';
    const cachePath = getCacheFilePath(target, 'mp3');
    const { calls, restore } = stubFetch((url) =>
      url.includes('evil.example')
        ? new Response('EVIL-BYTES', { status: 200, headers: { 'content-type': 'audio/mpeg' } })
        : redirect('https://evil.example/x.mp3')
    );
    try {
      await cacheRemoteMedia(target, cachePath);
      assert.ok(!isCached(cachePath));
      assert.ok(!calls.some((u) => u.includes('evil.example')));
      assert.strictEqual(getActiveDownloadCount(), 0);
    } finally {
      restore();
    }
  });

  await t.test('a stalled transfer frees its slot and leaves no temp file', async () => {
    await withEnv({ UPSTREAM_IDLE_TIMEOUT_MS: '80' }, async () => {
      const target = 'https://www.fayun.org/ftpadmin/media/__bg_stall__.mp3';
      const cachePath = getCacheFilePath(target, 'mp3');
      const { restore } = stubFetch(() => {
        let sent = false;
        const body = new ReadableStream<Uint8Array>({
          pull(c) {
            if (!sent) {
              sent = true;
              c.enqueue(new Uint8Array(16));
            }
            return new Promise(() => {});
          }
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': '1000' } });
      });
      try {
        const started = Date.now();
        await cacheRemoteMedia(target, cachePath);
        assert.ok(Date.now() - started < 3000, 'the download must give up instead of hanging');
        assert.ok(!isCached(cachePath));
        assert.strictEqual(getActiveDownloadCount(), 0, 'the slot must be released');
        const leftovers = fs.readdirSync(getCacheDir()).filter((f) => f.includes(cachePath.split('/').pop()!.split('.')[0]));
        assert.deepStrictEqual(leftovers, [], 'no temp residue');
      } finally {
        restore();
      }
    });
  });

  await t.test('three stalled origins no longer wedge later downloads', async () => {
    await withEnv({ UPSTREAM_TIMEOUT_MS: '80' }, async () => {
      const { restore } = stubFetch((url, init) =>
        url.includes('__wedge_') ? neverAnswers(init) : new Response('GOOD', { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': '4' } })
      );
      try {
        const stalled = [1, 2, 3].map((i) => {
          const u = `https://www.fayun.org/ftpadmin/media/__wedge_${i}__.mp3`;
          return cacheRemoteMedia(u, getCacheFilePath(u, 'mp3'));
        });
        const good = 'https://www.fayun.org/ftpadmin/media/__after_wedge__.mp3';
        const goodPath = getCacheFilePath(good, 'mp3');
        await Promise.all([...stalled, cacheRemoteMedia(good, goodPath)]);
        assert.ok(isCached(goodPath), 'a download queued behind stalled ones must still complete');
      } finally {
        restore();
      }
    });
  });
});

test('MEDIA_CACHE_DIR without a data segment is rejected loudly, once', () => {
  const saved = process.env.MEDIA_CACHE_DIR;
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
  try {
    process.env.MEDIA_CACHE_DIR = '/srv/cache-without-the-word';
    const a = getCacheDir();
    const b = getCacheDir();
    assert.ok(a.endsWith('/data/media_cache') && a === b, 'falls back to the default directory');
    assert.strictEqual(warnings.filter((w) => w.includes('Ignoring MEDIA_CACHE_DIR')).length, 1);
  } finally {
    console.warn = originalWarn;
    process.env.MEDIA_CACHE_DIR = saved;
  }
});
