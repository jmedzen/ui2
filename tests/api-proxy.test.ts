import test from 'node:test';
import assert from 'node:assert';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/proxy/route';
import { getTaskToken } from '@/lib/serverTasks';

test('API Proxy Security & Routing Suite', async (t) => {
  await t.test('blocks external domains to prevent SSRF (Forbidden 403)', async () => {
    const maliciousUrls = [
      'http://localhost:8410/api/proxy?url=http://google.com/test.mp3',
      'http://localhost:8410/api/proxy?url=https://attacker.com/evil.mp3',
      'http://localhost:8410/api/proxy?url=http://169.254.169.254/latest/meta-data',
      'http://localhost:8410/api/proxy?url=http://127.0.0.1:8080/secret'
    ];

    for (const urlStr of maliciousUrls) {
      const req = new NextRequest(urlStr);
      const res = await GET(req);
      assert.strictEqual(res.status, 403, `Must return 403 Forbidden for external target: ${urlStr}`);
      const text = await res.text();
      assert.ok(text.includes('Forbidden'), 'Response body must state Forbidden');
    }
  });

  await t.test('blocks path traversal attempts (Bad Request 400)', async () => {
    const traversalUrls = [
      'http://localhost:8410/api/proxy?path=../../etc/passwd',
      'http://localhost:8410/api/proxy?path=%2e%2e%2f%2e%2e%2fsecret',
      'http://localhost:8410/api/proxy?path=audio/../../../var/log'
    ];

    for (const urlStr of traversalUrls) {
      const req = new NextRequest(urlStr);
      const res = await GET(req);
      assert.strictEqual(res.status, 400, `Must return 400 for path traversal: ${urlStr}`);
    }
  });

  await t.test('returns 400 when both url and path parameters are missing', async () => {
    const req = new NextRequest('http://localhost:8410/api/proxy');
    const res = await GET(req);
    assert.strictEqual(res.status, 400, 'Must return 400 when neither url nor path is supplied');
  });

  await t.test('action=status probes cache status cleanly', async () => {
    const req = new NextRequest('http://localhost:8410/api/proxy?path=/audio/non_existent_file.mp3&action=status');
    const res = await GET(req);
    assert.strictEqual(res.status, 200, 'action=status must return 200 JSON');
    const data = await res.json();
    assert.strictEqual(typeof data.isCached, 'boolean', 'data.isCached must be a boolean');
    assert.strictEqual(data.isCached, false, 'Non-existent file must report isCached=false');
  });

  await t.test('action=preload triggers non-blocking cache request', async () => {
    // A preload persists a remote file to disk, so it requires the task token
    // (authorizeTaskRequest is fail-closed). Sending it is what the browser does
    // once the operator has pasted the boot token into Settings.
    const req = new NextRequest('http://localhost:8410/api/proxy?path=/audio/test_preload.mp3&action=preload', {
      headers: { 'x-task-token': getTaskToken() }
    });
    const res = await GET(req);
    assert.strictEqual(res.status, 200, 'action=preload must return 200 JSON');
    const data = await res.json();
    assert.strictEqual(data.status, 'preloading', 'Preload status must be preloading');
  });

  await t.test('does not crash on malformed percent-encoding (URI malformed)', async () => {
    // Real fayun.org filenames contain a bare "%" (e.g. "100%講記").
    // decodeURIComponent would throw URIError and previously surfaced as HTTP 500.
    const encoded = encodeURIComponent('/media/100%講記/a.mp3');
    const req = new NextRequest(`http://localhost:8410/api/proxy?path=${encoded}&action=status`);
    const res = await GET(req);
    assert.strictEqual(res.status, 200, 'Malformed percent sequence must not produce a 500');
  });

  await t.test('preserves ampersands inside media paths instead of truncating', async () => {
    // "Master's Teaching & Glossary" is a real directory name in the catalog.
    const encoded = encodeURIComponent('/media/english/A&B/audio/talk.mp3');
    const req = new NextRequest(`http://localhost:8410/api/proxy?path=${encoded}&action=status`);
    const res = await GET(req);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(
      data.targetUrl.includes('A&B'),
      `Ampersand must survive path parsing, got: ${data.targetUrl}`
    );
  });

  await t.test('rejects cross-site task triggers on the maintenance APIs', async () => {
    const { POST: scanPost } = await import('@/app/api/scan/route');
    const { POST: healPost } = await import('@/app/api/health-check/route');

    // A browser-declared cross-site request is refused outright, before the
    // credential is even considered.
    const crossSiteReq = new Request('http://localhost:8410/api/scan', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site' }
    });
    const scanRes = await scanPost(crossSiteReq);
    assert.strictEqual(scanRes.status, 403, 'Cross-site scan trigger must be rejected');

    // A foreign Origin is no longer a trust signal: Origin and Host are both
    // client-supplied, so they cannot validate each other. Such a request is
    // refused for the real reason -- it presents no credential (401) -- rather
    // than because its Origin looked wrong (403). Asserting 403 here would
    // re-encode the old, forgeable check as if it were a security boundary.
    const healReq = new Request('http://localhost:8410/api/health-check', {
      method: 'POST',
      headers: { origin: 'https://evil.example.com' }
    });
    const healRes = await healPost(healReq);
    assert.strictEqual(healRes.status, 401, 'An unauthenticated heal trigger must be rejected');

    // A wrong-but-present credential is distinguished from a missing one, and
    // this path spawns no subprocess (it is rejected before the task starts).
    const wrongTokenReq = new Request('http://localhost:8410/api/health-check', {
      method: 'POST',
      headers: { 'x-task-token': 'definitely-not-the-token' }
    });
    const wrongTokenRes = await healPost(wrongTokenReq);
    assert.strictEqual(wrongTokenRes.status, 403, 'An invalid token must be rejected');
  });
});
