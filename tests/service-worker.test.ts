import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const SW_PATH = path.join(process.cwd(), 'public', 'sw.js');
const src = fs.readFileSync(SW_PATH, 'utf-8');

test('Service worker', async (t) => {
  await t.test('exists and is valid JavaScript', () => {
    assert.ok(src.length > 500, 'sw.js should not be a stub');
    // Parse without executing: a syntax error here would silently disable all
    // offline support, and the browser reports it only in devtools.
    assert.doesNotThrow(() => new Function(src));
  });

  await t.test('never caches a partial (206) media response', () => {
    // Storing a 206 body and replaying it produces silent gaps mid-lecture.
    assert.match(src, /response\.status === 200/);
    assert.match(src, /Range/i);
    assert.match(src, /request\.headers\.get\('range'\)/);
  });

  await t.test('only intercepts GET requests', () => {
    assert.match(src, /request\.method !== 'GET'/);
  });

  await t.test('leaves the admin and scan APIs uncached', () => {
    // A stale admin session or scan result is a security and correctness bug,
    // not a performance win.
    assert.match(src, /\/api\/admin\//);
    assert.match(src, /\/api\/scan/);
  });

  await t.test('only handles same-origin traffic', () => {
    assert.match(src, /url\.origin !== self\.location\.origin/);
  });

  await t.test('bounds the media cache', () => {
    assert.match(src, /MEDIA_CACHE_MAX_ENTRIES/);
    assert.match(src, /trimMediaCache/);
  });

  await t.test('does not pre-cache hashed build assets', () => {
    // Pre-caching would pin users to a stale bundle after every deploy, so the
    // install handler must not add to any cache.
    assert.match(src, /self\.addEventListener\('install'/, 'install handler should exist');
    const installBlock = src.slice(
      src.indexOf("self.addEventListener('install'"),
      src.indexOf("self.addEventListener('activate'")
    );
    assert.doesNotMatch(installBlock, /caches\.open/, 'install must not open a cache');
    assert.doesNotMatch(src, /_next\/static/);
  });

  await t.test('registration is skipped in development', () => {
    // A worker in `next dev` serves stale chunks after every edit.
    const hook = fs.readFileSync(
      path.join(process.cwd(), 'src', 'lib', 'useServiceWorker.ts'),
      'utf-8'
    );
    assert.match(hook, /process\.env\.NODE_ENV !== 'production'/);
    assert.match(hook, /navigator\.serviceWorker\.register\('\/sw\.js'/);
    // A blocked registration (private mode) must not break the page.
    assert.match(hook, /catch \(error\)/);
  });
});

/* ------------------------------------------------------------------ *
 * Behaviour: run the real worker in a VM with fake caches and fetch
 * ------------------------------------------------------------------ */

type Listener = (event: unknown) => void;

function loadWorker(network: (url: string, init?: RequestInit) => Response | Promise<Response>, opts: { saveData?: boolean } = {}) {
  const listeners: Record<string, Listener> = {};
  const store = new Map<string, Map<string, Response>>();
  const fetchCalls: { url: string; range: string | null }[] = [];
  const caches = {
    async open(name: string) {
      if (!store.has(name)) store.set(name, new Map());
      const m = store.get(name)!;
      return {
        async match(req: string | Request) {
          const key = typeof req === 'string' ? req : req.url;
          const hit = m.get(key);
          return hit ? hit.clone() : undefined;
        },
        async put(req: string | Request, res: Response) {
          m.set(typeof req === 'string' ? req : req.url, res.clone());
        },
        async keys() {
          return [...m.keys()].map((u) => new Request(u));
        },
        async delete(req: Request) {
          return m.delete(req.url);
        }
      };
    },
    async keys() {
      return [...store.keys()];
    },
    async delete(name: string) {
      return store.delete(name);
    }
  };
  const self = {
    location: { origin: 'https://ui2.test' },
    navigator: { connection: { saveData: Boolean(opts.saveData) } },
    addEventListener: (type: string, fn: Listener) => { listeners[type] = fn; },
    skipWaiting: async () => {},
    clients: { claim: async () => {} }
  };
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    fetchCalls.push({ url: req.url, range: req.headers.get('range') });
    return network(req.url, { headers: Object.fromEntries(req.headers) });
  };
  vm.runInNewContext(src, { self, caches, fetch: fakeFetch, Response, Request, URL, Blob, Headers, console });

  async function dispatch(url: string, headers: Record<string, string> = {}) {
    let responded: Promise<Response> | undefined;
    const waits: Promise<unknown>[] = [];
    listeners.fetch({
      request: new Request(url, { headers }),
      respondWith: (p: Promise<Response>) => { responded = p; },
      waitUntil: (p: Promise<unknown>) => { waits.push(p); }
    });
    const response = responded ? await responded : undefined;
    await Promise.all(waits);
    return response;
  }
  return { dispatch, fetchCalls, store };
}

const AUDIO = 'https://ui2.test/api/proxy?path=' + encodeURIComponent('/media/經/audio/01.mp3');
const BODY = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));

/** A minimal origin that honours single ranges like the real proxy does. */
function rangedOrigin(url: string, init?: RequestInit) {
  const range = new Headers(init?.headers).get('range');
  if (range) {
    const [, a, b] = /bytes=(\d+)-(\d*)/.exec(range)!;
    const start = Number(a);
    const end = b ? Number(b) : BODY.length - 1;
    return new Response(BODY.slice(start, end + 1), {
      status: 206,
      headers: { 'content-type': 'audio/mpeg', 'content-range': `bytes ${start}-${end}/${BODY.length}` }
    });
  }
  return new Response(BODY, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
}

test('Service worker — offline audio actually works', async (t) => {
  await t.test('audio played through /api/proxy?path= is recognised and filled once', async () => {
    const sw = loadWorker(rangedOrigin);
    const first = await sw.dispatch(AUDIO, { range: 'bytes=0-' });
    assert.ok(first, 'a ranged ?path= audio request must be handled (it was ignored before)');
    assert.strictEqual(first!.status, 206);
    // One ranged request for playback, one complete background fill.
    assert.deepStrictEqual(sw.fetchCalls.map((c) => c.range), ['bytes=0-', null]);
    assert.ok(sw.store.get('fayun-media-v2')?.has(AUDIO), 'the complete file must be cached');
  });

  await t.test('later range requests are cut from the cached copy without the network', async () => {
    const sw = loadWorker(rangedOrigin);
    await sw.dispatch(AUDIO, { range: 'bytes=0-' });
    const callsBefore = sw.fetchCalls.length;
    const res = await sw.dispatch(AUDIO, { range: 'bytes=10-19' });
    assert.strictEqual(sw.fetchCalls.length, callsBefore, 'served offline');
    assert.strictEqual(res!.status, 206);
    assert.strictEqual(res!.headers.get('content-range'), 'bytes 10-19/100');
    assert.deepStrictEqual([...new Uint8Array(await res!.arrayBuffer())], [...BODY.slice(10, 20)]);

    const suffix = await sw.dispatch(AUDIO, { range: 'bytes=-5' });
    assert.strictEqual(suffix!.headers.get('content-range'), 'bytes 95-99/100');
    const beyond = await sw.dispatch(AUDIO, { range: 'bytes=500-' });
    assert.strictEqual(beyond!.status, 416);
  });

  await t.test('a 206 partial body is never stored as the cached copy', async () => {
    // Origin that ignores the full request and still answers 206.
    const sw = loadWorker(() =>
      new Response(BODY.slice(0, 10), { status: 206, headers: { 'content-range': 'bytes 0-9/100' } })
    );
    await sw.dispatch(AUDIO, { range: 'bytes=0-9' });
    assert.ok(!sw.store.get('fayun-media-v2')?.has(AUDIO));
  });

  await t.test('Save-Data, video and oversized files never trigger a background fill', async () => {
    const saving = loadWorker(rangedOrigin, { saveData: true });
    await saving.dispatch(AUDIO, { range: 'bytes=0-' });
    assert.strictEqual(saving.fetchCalls.length, 1);

    const video = loadWorker(rangedOrigin);
    await video.dispatch('https://ui2.test/api/proxy?path=' + encodeURIComponent('/media/v/01.mp4'), { range: 'bytes=0-' });
    assert.strictEqual(video.fetchCalls.length, 1);

    const huge = loadWorker(() =>
      new Response(BODY.slice(0, 1), { status: 206, headers: { 'content-range': `bytes 0-0/${500 * 1024 * 1024}` } })
    );
    await huge.dispatch(AUDIO, { range: 'bytes=0-0' });
    assert.strictEqual(huge.fetchCalls.length, 1);
  });

  await t.test('status/preload probes and the admin API are not intercepted', async () => {
    const sw = loadWorker(rangedOrigin);
    assert.strictEqual(await sw.dispatch(AUDIO + '&action=status'), undefined);
    assert.strictEqual(await sw.dispatch('https://ui2.test/api/admin/session'), undefined);
    assert.strictEqual(await sw.dispatch('https://other.test/x.mp3', { range: 'bytes=0-' }), undefined);
  });
});
