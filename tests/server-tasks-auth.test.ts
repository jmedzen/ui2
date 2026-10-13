// Must come first: points MEDIA_CACHE_DIR at a throwaway directory.
import './helpers/isolated-media-cache';

import test from 'node:test';
import assert from 'node:assert';
import { authorizeTaskRequest } from '@/lib/serverTasks';

/** Builds a POST request with an explicit Host/Origin, as a browser would send. */
function mk(url: string, headers: Record<string, string>) {
  return new Request(url, { method: 'POST', headers });
}

test('authorizeTaskRequest — same-origin detection', async (t) => {
  const allowed: [string, string, Record<string, string>][] = [
    ['plain direct request', 'http://localhost:8410/api/scan', { host: 'localhost:8410', origin: 'http://localhost:8410' }],
    // Regression: behind Caddy the internal request URL is http://fyweb:8410
    // while the browser's Origin is the public https host. Comparing Origin to
    // request.url rejected every legitimate trigger from the app's own UI.
    ['reverse proxy, Host preserved', 'http://fyweb:8410/api/scan', { host: 'myhost.org', origin: 'https://myhost.org' }],
    ['reverse proxy, x-forwarded-host', 'http://fyweb:8410/api/scan', { host: 'fyweb:8410', 'x-forwarded-host': 'myhost.org', origin: 'https://myhost.org' }],
    ['origin omits default https port', 'http://fyweb:8410/api/scan', { host: 'myhost.org', origin: 'https://myhost.org' }],
    ['explicit :443 origin', 'http://fyweb:8410/api/scan', { host: 'myhost.org', origin: 'https://myhost.org:443' }],
    ['browser same-origin metadata', 'http://fyweb:8410/api/scan', { host: 'fyweb:8410', 'sec-fetch-site': 'same-origin', origin: 'https://myhost.org' }],
    ['user-navigated (sec-fetch none)', 'http://fyweb:8410/api/scan', { host: 'fyweb:8410', 'sec-fetch-site': 'none' }],
    ['comma-separated forwarded chain', 'http://fyweb:8410/api/scan', { host: 'fyweb:8410', 'x-forwarded-host': 'myhost.org, inner', origin: 'https://myhost.org' }],
  ];

  for (const [name, url, headers] of allowed) {
    await t.test(`allows ${name}`, () => {
      const result = authorizeTaskRequest(mk(url, headers));
      assert.strictEqual(result.ok, true, `expected allow, got: ${result.ok ? '' : result.message}`);
    });
  }
});

test('authorizeTaskRequest — rejects cross-origin and malformed input', async (t) => {
  const denied: [string, string, Record<string, string>][] = [
    ['foreign origin', 'http://myhost.org/api/scan', { host: 'myhost.org', origin: 'https://evil.com' }],
    ['cross-site fetch metadata', 'http://myhost.org/api/scan', { host: 'myhost.org', 'sec-fetch-site': 'cross-site', origin: 'https://evil.com' }],
    ['lookalike host', 'http://myhost.org/api/scan', { host: 'myhost.org', origin: 'https://myhost.org.evil.com' }],
    ['userinfo trick', 'http://myhost.org/api/scan', { host: 'myhost.org', origin: 'https://myhost.org@evil.com' }],
    ['same host, different port', 'http://myhost.org:8410/api/scan', { host: 'myhost.org:8410', origin: 'http://myhost.org:9999' }],
    ['malformed origin', 'http://myhost.org/api/scan', { host: 'myhost.org', origin: 'not-a-url' }],
  ];

  for (const [name, url, headers] of denied) {
    await t.test(`denies ${name}`, () => {
      const result = authorizeTaskRequest(mk(url, headers));
      assert.strictEqual(result.ok, false, 'expected the request to be denied');
      assert.strictEqual(result.status, 403);
    });
  }
});

test('authorizeTaskRequest — token takes precedence when configured', async (t) => {
  const previous = process.env.TASK_API_TOKEN;
  process.env.TASK_API_TOKEN = 'correct-horse-battery-staple';

  t.after(() => {
    if (previous === undefined) delete process.env.TASK_API_TOKEN;
    else process.env.TASK_API_TOKEN = previous;
  });

  await t.test('rejects a request with no token', () => {
    const result = authorizeTaskRequest(mk('http://myhost.org/api/scan', { host: 'myhost.org', origin: 'https://myhost.org' }));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 401);
  });

  await t.test('rejects a wrong token', () => {
    const result = authorizeTaskRequest(
      mk('http://myhost.org/api/scan', { host: 'myhost.org', 'x-task-token': 'nope' })
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 403);
  });

  await t.test('accepts the correct token via header', () => {
    const result = authorizeTaskRequest(
      mk('http://myhost.org/api/scan', { host: 'myhost.org', 'x-task-token': 'correct-horse-battery-staple' })
    );
    assert.strictEqual(result.ok, true);
  });

  await t.test('accepts the correct token via bearer authorization', () => {
    const result = authorizeTaskRequest(
      mk('http://myhost.org/api/scan', { host: 'myhost.org', authorization: 'Bearer correct-horse-battery-staple' })
    );
    assert.strictEqual(result.ok, true);
  });

  await t.test('token is required even for a same-origin request', () => {
    const result = authorizeTaskRequest(
      mk('http://myhost.org/api/scan', { host: 'myhost.org', 'sec-fetch-site': 'same-origin' })
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 401);
  });
});
