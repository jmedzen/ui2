import test from 'node:test';
import assert from 'node:assert';
import { cleanMediaPath, getOptimalMediaRoute } from '@/lib/speedTester';

test('Dual-Path Speed Tester & Routing Logic Suite', async (t) => {
  await t.test('cleanMediaPath strips proxy wrappers cleanly', () => {
    const raw1 = '/audio/01.mp3';
    assert.strictEqual(cleanMediaPath(raw1), '/audio/01.mp3');

    const raw2 = '/api/proxy?path=%2Faudio%2F01.mp3&extra=1';
    assert.strictEqual(cleanMediaPath(raw2), '/audio/01.mp3');

    const raw3 = '/api/proxy?url=https%3A%2F%2Fwww.fayun.org%2Fftpadmin%2F01.mp4';
    assert.strictEqual(cleanMediaPath(raw3), 'https://www.fayun.org/ftpadmin/01.mp4');

    assert.strictEqual(cleanMediaPath(''), '');
  });

  await t.test('cleanMediaPath prevents nested encoding accumulation', () => {
    let nested = '/audio/test.mp3';
    for (let i = 0; i < 5; i++) {
      nested = `/api/proxy?path=${encodeURIComponent(nested)}`;
    }
    const cleaned = cleanMediaPath(nested);
    assert.strictEqual(cleaned, '/audio/test.mp3');
  });

  await t.test('cleanMediaPath tolerates malformed percent sequences without throwing', () => {
    // A bare "%" is invalid percent-encoding; decoding must not raise URIError.
    const malformed = '/api/proxy?path=%2Fmedia%2F100%25test.mp3';
    assert.doesNotThrow(() => cleanMediaPath(malformed));

    const rawPercent = '/media/100%講記/a.mp3';
    assert.strictEqual(cleanMediaPath(rawPercent), rawPercent);
  });

  await t.test('probe buffers only a bounded chunk and never the whole body', async (t) => {
    const originalFetch = globalThis.fetch;
    let cancelled = 0;
    let produced = 0;
    const CHUNK = 8 * 1024;
    const TOTAL_CHUNKS = 500; // ~4 MB, far beyond the probe budget

    // The probe shares `fetch` with the status/preload helpers, so route by URL:
    // otherwise a status poll's JSON body would be captured by the media counter.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('action=status')) {
        return new Response(JSON.stringify({ isCached: false }), { status: 200 });
      }
      if (url.includes('action=preload')) {
        return new Response('ok', { status: 200 });
      }
      const stream = new ReadableStream({
        pull(controller) {
          if (produced >= TOTAL_CHUNKS) {
            controller.close();
            return;
          }
          produced++;
          controller.enqueue(new Uint8Array(CHUNK));
        },
        cancel() {
          cancelled++;
        }
      });
      return new Response(stream, { status: 206, headers: { 'Content-Type': 'audio/mpeg' } });
    }) as typeof fetch;

    t.after(() => {
      globalThis.fetch = originalFetch;
    });

    const result = await getOptimalMediaRoute(
      '/audio/probe-budget.mp3',
      'https://www.fayun.org/ftpadmin/probe-budget.mp3'
    );

    assert.strictEqual(typeof result.activeUrl, 'string');
    assert.strictEqual(cancelled, 2, 'Both probe streams must be cancelled once the budget is met');
    assert.ok(
      produced < TOTAL_CHUNKS,
      `Probe must stop early; produced ${produced}/${TOTAL_CHUNKS} chunks`
    );
  });
});
