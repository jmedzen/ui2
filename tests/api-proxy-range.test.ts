import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/proxy/route';
import { getCacheFilePath, ensureCacheDir, getCacheKey } from '@/lib/serverMediaCache';

/**
 * Seeds a cache file for a given remote path and returns the local file path.
 * The proxy derives its cache key from the fully-qualified fayun.org URL.
 */
function seedCacheFile(remotePath: string, ext: string, bytes: number): string {
  ensureCacheDir();
  const targetUrl = `https://www.fayun.org/ftpadmin${remotePath}`;
  const filePath = getCacheFilePath(targetUrl, ext);
  fs.writeFileSync(filePath, Buffer.alloc(bytes, 0x42));
  return filePath;
}

const FIXTURE_PATH = '/media/__range_fixture__/sample.mp3';
const FIXTURE_SIZE = 5000;

test('HTTP Range handling on cache HIT', async (t) => {
  const filePath = seedCacheFile(FIXTURE_PATH, 'mp3', FIXTURE_SIZE);
  t.after(() => {
    try {
      fs.unlinkSync(filePath);
    } catch {}
  });

  const rangeRequest = (range: string) => {
    const req = new NextRequest(`http://localhost:8410/api/proxy?path=${encodeURIComponent(FIXTURE_PATH)}`, {
      headers: { Range: range }
    });
    return GET(req);
  };

  await t.test('explicit range returns exactly the requested byte span', async () => {
    const res = await rangeRequest('bytes=0-999');
    assert.strictEqual(res.status, 206);
    assert.strictEqual(res.headers.get('content-range'), `bytes 0-999/${FIXTURE_SIZE}`);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(buf.length, 1000);
  });

  await t.test('open-ended range returns the remainder of the file', async () => {
    const res = await rangeRequest(`bytes=${FIXTURE_SIZE - 1000}-`);
    assert.strictEqual(res.status, 206);
    assert.strictEqual(res.headers.get('content-range'), `bytes ${FIXTURE_SIZE - 1000}-${FIXTURE_SIZE - 1}/${FIXTURE_SIZE}`);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(buf.length, 1000);
  });

  await t.test('suffix range returns the LAST N bytes, not the first N', async () => {
    // Regression: "bytes=-1000" was previously parsed as "0-1000", returning the
    // beginning of the file. Browsers use suffix ranges to sniff trailing metadata.
    const res = await rangeRequest('bytes=-1000');
    assert.strictEqual(res.status, 206);
    assert.strictEqual(
      res.headers.get('content-range'),
      `bytes ${FIXTURE_SIZE - 1000}-${FIXTURE_SIZE - 1}/${FIXTURE_SIZE}`,
      'Suffix range must be resolved against the END of the file'
    );
    const buf = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(buf.length, 1000);
  });

  await t.test('inverted range does not crash with a 500', async () => {
    // Regression: "bytes=100-50" previously threw ERR_OUT_OF_RANGE from
    // fs.createReadStream and leaked the internal message as a 500 response.
    const res = await rangeRequest('bytes=100-50');
    assert.notStrictEqual(res.status, 500, 'Inverted range must not produce a 500');
    assert.ok([200, 206, 416].includes(res.status), `Unexpected status ${res.status}`);
  });

  await t.test('malformed range falls back to a full response', async () => {
    const res = await rangeRequest('bytes=abc-def');
    assert.notStrictEqual(res.status, 500);
    assert.ok([200, 416].includes(res.status));
    if (res.status === 200) {
      assert.strictEqual(res.headers.get('content-length'), String(FIXTURE_SIZE));
    }
  });

  await t.test('range starting past EOF returns 416', async () => {
    const res = await rangeRequest(`bytes=${FIXTURE_SIZE + 100}-`);
    assert.strictEqual(res.status, 416);
    assert.strictEqual(res.headers.get('content-range'), `bytes */${FIXTURE_SIZE}`);
  });

  await t.test('multi-range request does not produce a corrupt single part', async () => {
    const res = await rangeRequest('bytes=0-99,200-299');
    assert.notStrictEqual(res.status, 206, 'Multi-range must not masquerade as a single-part 206');
    assert.ok([200, 416].includes(res.status));
  });

  await t.test('full request without Range returns the whole file', async () => {
    const req = new NextRequest(`http://localhost:8410/api/proxy?path=${encodeURIComponent(FIXTURE_PATH)}`);
    const res = await GET(req);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-length'), String(FIXTURE_SIZE));
    const buf = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(buf.length, FIXTURE_SIZE);
  });

  await t.test('HTML-shaped cache entry is never reported as cached', async () => {
    // Regression: a 200 HTML SPA page from the origin was persisted as *.mp3 and
    // then reported as isCached=true forever, breaking playback.
    const htmlPath = '/media/__poison_fixture__/fake.mp3';
    const htmlFile = seedCacheFile(htmlPath, 'mp3', 0);
    fs.writeFileSync(htmlFile, '<!doctype html><html><body>SPA fallback</body></html>');
    try {
      const req = new NextRequest(`http://localhost:8410/api/proxy?path=${encodeURIComponent(htmlPath)}&action=status`);
      const res = await GET(req);
      const data = await res.json();
      assert.strictEqual(data.isCached, false, 'HTML payload must not be reported as a cached media file');
    } finally {
      try {
        fs.unlinkSync(htmlFile);
      } catch {}
    }
  });

  await t.test('cache key derivation is stable for the fixture', () => {
    const targetUrl = `https://www.fayun.org/ftpadmin${FIXTURE_PATH}`;
    assert.strictEqual(getCacheKey(targetUrl).length, 32);
  });
});
