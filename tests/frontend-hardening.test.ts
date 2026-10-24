import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import type { CourseItem } from '@/types/course';
import { discoverAudioTracks } from '@/lib/useAudioTracks';
import {
  getOptimalMediaRoute,
  isDirectProbeBlocked,
  resetDirectProbeStateForTests,
  resolvePlaybackRoute,
  withDeadline
} from '@/lib/speedTester';

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf-8');

const course = { id: 1, name: '測試課程', audio_path: '/media/test/audio' } as unknown as CourseItem;

const listing = (files: string[]) =>
  new Response(JSON.stringify({ status: true, data: files }), { status: 200, headers: { 'content-type': 'application/json' } });

/* ------------------------------------------------------------------ *
 * useAudioTracks: a superseded run must never commit
 * ------------------------------------------------------------------ */

test('audio discovery — superseded runs are discarded', async (t) => {
  await t.test('a normal run returns the tracks', async () => {
    const res = await discoverAudioTracks(course, new AbortController().signal, (async () => listing(['02.mp3', '01.mp3', 'x.txt'])) as typeof fetch);
    assert.ok(res);
    assert.deepStrictEqual(res!.tracks.map((x) => x.filename), ['01.mp3', '02.mp3']);
    assert.strictEqual(res!.error, null);
    assert.match(res!.tracks[0].proxyUrl, /^\/api\/proxy\?path=/);
  });

  await t.test('aborting mid-flight yields null, not a "cannot connect" error', async () => {
    // Regression: the abort made every probe "fail", so the stale run set the
    // error banner and isLoading=false on top of the NEW course's load.
    const controller = new AbortController();
    const fetchImpl = ((_: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as typeof fetch;
    const pending = discoverAudioTracks(course, controller.signal, fetchImpl);
    controller.abort();
    assert.strictEqual(await pending, null);
  });

  await t.test('a run that finishes after being superseded yields null, not stale tracks', async () => {
    const controller = new AbortController();
    const fetchImpl = (async () => {
      controller.abort(); // the reader switched course while this response was in flight
      return listing(['old-course.mp3']);
    }) as typeof fetch;
    assert.strictEqual(await discoverAudioTracks(course, controller.signal, fetchImpl), null);
  });

  await t.test('a genuine total failure still reports the error', async () => {
    const res = await discoverAudioTracks(course, new AbortController().signal, (async () => new Response('', { status: 502 })) as typeof fetch);
    assert.strictEqual(res?.error, '無法連線至音訊清單服務。');
  });

  await t.test('the hook ties ownership to a per-run AbortController', () => {
    const src = read('src/lib/useAudioTracks.ts');
    assert.doesNotMatch(src, /useRef\(/, 'a shared ref is reset by the next run and cannot tell runs apart');
    assert.match(src, /if \(!result \|\| controller\.signal\.aborted\) return;/);
  });
});

/* ------------------------------------------------------------------ *
 * Speed tester: CORS-blocked direct probe, gesture-bounded routing
 * ------------------------------------------------------------------ */

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): { calls: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    return handler(url, init);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const sameOrigin = async (url: string) => {
  if (url.includes('action=status')) return new Response(JSON.stringify({ isCached: false }));
  if (url.includes('action=preload')) return new Response('{}');
  return new Response(new Uint8Array(1024), { status: 206 });
};

test('speed tester — a CORS-refused direct probe is not retried every track', async () => {
  resetDirectProbeStateForTests();
  const { calls, restore } = stubFetch(async (url) => {
    if (url.startsWith('https://www.fayun.org')) throw new TypeError('Failed to fetch'); // CORS refusal
    return sameOrigin(url);
  });
  try {
    const a = await getOptimalMediaRoute('/media/cors/a.mp3', 'https://www.fayun.org/ftpadmin/media/cors/a.mp3');
    assert.strictEqual(a.route, 'proxy');
    assert.ok(isDirectProbeBlocked());
    const before = calls.filter((u) => u.startsWith('https://www.fayun.org')).length;
    await getOptimalMediaRoute('/media/cors/b.mp3', 'https://www.fayun.org/ftpadmin/media/cors/b.mp3');
    const after = calls.filter((u) => u.startsWith('https://www.fayun.org')).length;
    assert.strictEqual(after, before, 'the direct origin must not be probed again');
  } finally {
    restore();
    resetDirectProbeStateForTests();
  }
});

test('speed tester — a slow direct link (timeout) does not disable direct probing', async () => {
  resetDirectProbeStateForTests();
  const { restore } = stubFetch(async (url, init) => {
    if (url.startsWith('https://www.fayun.org')) {
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')))
      );
    }
    return sameOrigin(url);
  });
  try {
    await getOptimalMediaRoute('/media/slow/a.mp3', 'https://www.fayun.org/ftpadmin/media/slow/a.mp3');
    assert.strictEqual(isDirectProbeBlocked(), false);
  } finally {
    restore();
  }
});

test('speed tester — user-initiated play is bounded by the gesture deadline', async () => {
  resetDirectProbeStateForTests();
  // Everything hangs: status, probes. Only the deadline can answer.
  const { restore } = stubFetch((_, init) => new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')));
  }));
  try {
    const started = Date.now();
    const res = await resolvePlaybackRoute('/media/hang/a.mp3', 'https://www.fayun.org/ftpadmin/media/hang/a.mp3', 60);
    assert.ok(Date.now() - started < 1000, 'must not wait for the full evaluation');
    assert.strictEqual(res.route, 'proxy');
    assert.strictEqual(res.activeUrl, `/api/proxy?path=${encodeURIComponent('/media/hang/a.mp3')}`);
  } finally {
    restore();
  }
  assert.strictEqual(await withDeadline(Promise.resolve(7), 50, 0), 7);
  assert.strictEqual(await withDeadline(Promise.reject(new Error('x')), 50, 0), 0);
  assert.strictEqual(await withDeadline(new Promise<number>(() => {}), 20, 3), 3);
});

test('playTrack uses the bounded route and status lookups', () => {
  const src = read('src/context/AudioContext.tsx');
  const play = src.slice(src.indexOf('const playTrack = useCallback'));
  const head = play.slice(0, play.indexOf('.play()'));
  assert.match(head, /resolvePlaybackRoute\(targetTrack\.proxyUrl, targetTrack\.url\)/);
  assert.match(head, /withDeadline\(fetchCacheStatus\(targetTrack\.proxyUrl\), USER_PLAY_ROUTE_DEADLINE_MS, false\)/);
  assert.doesNotMatch(head, /getOptimalMediaRoute\(targetTrack/);
});

test('the catalog fetch revalidates with the ETag instead of busting it', () => {
  const src = read('src/app/page.tsx');
  assert.match(src, /fetch\('\/api\/courses', \{\s*cache: 'no-cache'\s*\}\)/);
  assert.doesNotMatch(src, /fetch\(`\/api\/courses\?t=/);
});
