import test from 'node:test';
import assert from 'node:assert';
import { cleanMediaPath } from '@/lib/speedTester';

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
});
