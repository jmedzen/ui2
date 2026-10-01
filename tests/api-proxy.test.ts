import test from 'node:test';
import assert from 'node:assert';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/proxy/route';

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
    const req = new NextRequest('http://localhost:8410/api/proxy?path=/audio/test_preload.mp3&action=preload');
    const res = await GET(req);
    assert.strictEqual(res.status, 200, 'action=preload must return 200 JSON');
    const data = await res.json();
    assert.strictEqual(data.status, 'preloading', 'Preload status must be preloading');
  });
});
