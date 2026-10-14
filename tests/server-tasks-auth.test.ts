// Must come first: points MEDIA_CACHE_DIR at a throwaway directory.
import './helpers/isolated-media-cache';

import test from 'node:test';
import assert from 'node:assert';
import {
  authorizeTaskRequest,
  getTaskToken,
  resetGeneratedTaskToken,
  isTaskTokenExplicit
} from '@/lib/serverTasks';

/** Builds a POST request with an explicit Host/Origin, as a browser would send. */
function mk(url: string, headers: Record<string, string>) {
  return new Request(url, { method: 'POST', headers });
}

/** Runs `fn` with TASK_API_TOKEN set to `value`, restoring the previous state. */
async function withToken(value: string | undefined, fn: () => Promise<void> | void) {
  const previous = process.env.TASK_API_TOKEN;
  if (value === undefined) delete process.env.TASK_API_TOKEN;
  else process.env.TASK_API_TOKEN = value;
  resetGeneratedTaskToken();
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.TASK_API_TOKEN;
    else process.env.TASK_API_TOKEN = previous;
    resetGeneratedTaskToken();
  }
}

test('authorizeTaskRequest — browser metadata alone never authorizes', async (t) => {
  await withToken(undefined, async () => {
    // Every one of these used to be ALLOWED whenever TASK_API_TOKEN was unset.
    // They are all client-supplied headers, and a non-browser client simply
    // omits or forges them, so they cannot gate a process-spawning endpoint.
    const formerlyTrusted: [string, Record<string, string>][] = [
      ['same-origin fetch metadata', { host: 'myhost.org', 'sec-fetch-site': 'same-origin', origin: 'https://myhost.org' }],
      ['user-navigated (sec-fetch none)', { host: 'myhost.org', 'sec-fetch-site': 'none' }],
      ['matching Origin', { host: 'myhost.org', origin: 'https://myhost.org' }],
      ['reverse proxy x-forwarded-host', { host: 'fyweb:8410', 'x-forwarded-host': 'myhost.org', origin: 'https://myhost.org' }],
      ['comma-separated forwarded chain', { host: 'fyweb:8410', 'x-forwarded-host': 'myhost.org, inner', origin: 'https://myhost.org' }],
      ['no headers at all (plain curl)', {}]
    ];

    for (const [name, headers] of formerlyTrusted) {
      await t.test(`denies ${name} without a token`, () => {
        const result = authorizeTaskRequest(mk('http://myhost.org/api/scan', headers));
        assert.strictEqual(result.ok, false, 'expected the request to be denied');
        assert.strictEqual(result.status, 401);
      });
    }
  });
});

test('authorizeTaskRequest — a forged Origin+Host pair cannot authorize', async () => {
  await withToken(undefined, () => {
    // The old code derived the trusted authority set FROM these same headers and
    // then compared Origin against it, so a caller could validate itself by
    // sending a consistent pair. Verified live before the fix: no headers was
    // ALLOWED, and `Origin: http://evil.com` + `Host: evil.com` was ALLOWED.
    const result = authorizeTaskRequest(
      mk('http://127.0.0.1:8410/api/scan', { host: 'evil.com', origin: 'http://evil.com' })
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 401);
  });
});

test('authorizeTaskRequest — generated token gates the endpoints (default config)', async () => {
  await withToken(undefined, () => {
    assert.strictEqual(isTaskTokenExplicit(), false);
    const token = getTaskToken();
    assert.ok(token.length >= 32, 'generated token should be long');

    // Stable across calls within a boot, so the same value can be advertised.
    assert.strictEqual(getTaskToken(), token);

    const ok = authorizeTaskRequest(mk('http://myhost.org/api/scan', { 'x-task-token': token }));
    assert.strictEqual(ok.ok, true);

    const bad = authorizeTaskRequest(mk('http://myhost.org/api/scan', { 'x-task-token': 'wrong' }));
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.status, 403);
  });
});

test('authorizeTaskRequest — reports why a token is needed when none is configured', async () => {
  await withToken(undefined, () => {
    const result = authorizeTaskRequest(mk('http://myhost.org/api/scan', {}));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 401);
    // The message must tell the operator where to find the generated token.
    assert.match(result.message, /TASK_API_TOKEN/);
  });
});

test('authorizeTaskRequest — cross-site is rejected before anything else', async (t) => {
  await withToken(undefined, async () => {
    await t.test('cross-site fetch metadata is 403 even with a valid token', () => {
      const result = authorizeTaskRequest(
        mk('http://myhost.org/api/scan', { 'sec-fetch-site': 'cross-site', 'x-task-token': getTaskToken() })
      );
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.status, 403);
    });
  });
});

test('authorizeTaskRequest — explicit token takes precedence', async (t) => {
  await withToken('correct-horse-battery-staple', async () => {
    assert.strictEqual(isTaskTokenExplicit(), true);
    assert.strictEqual(getTaskToken(), 'correct-horse-battery-staple');

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

    await t.test('a token of the right length but wrong value is rejected', () => {
      // Guards the timingSafeEqual length shortcut: equal lengths must still fail.
      const result = authorizeTaskRequest(
        mk('http://myhost.org/api/scan', { 'x-task-token': 'correct-horse-battery-staple'.replace('c', 'x') })
      );
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.status, 403);
    });
  });
});
