import test from 'node:test';
import assert from 'node:assert';
import {
  authorizePreloadRequest,
  getTaskToken,
  isTaskTokenExplicit,
  isValidTaskToken
} from '@/lib/serverTasks';

function mk(url: string, headers: Record<string, string>) {
  return new Request(url, { method: 'GET', headers });
}

async function withToken(value: string | undefined, fn: () => Promise<void> | void) {
  const previous = process.env.TASK_API_TOKEN;
  if (value === undefined) delete process.env.TASK_API_TOKEN;
  else process.env.TASK_API_TOKEN = value;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.TASK_API_TOKEN;
    else process.env.TASK_API_TOKEN = previous;
  }
}

test('preload auth — same-origin browser requests authorize without a token', async (t) => {
  await withToken(undefined, async () => {
    const browserRequests: [string, Record<string, string>][] = [
      ['same-origin fetch metadata', { host: 'myhost.org', 'sec-fetch-site': 'same-origin', origin: 'https://myhost.org' }],
      ['matching Origin', { host: 'myhost.org', origin: 'https://myhost.org' }],
      ['reverse proxy x-forwarded-host', { host: 'ui2:8410', 'x-forwarded-host': 'myhost.org', origin: 'https://myhost.org' }],
      ['comma-separated forwarded chain', { host: 'ui2:8410', 'x-forwarded-host': 'myhost.org, inner', origin: 'https://myhost.org' }]
    ];

    for (const [name, headers] of browserRequests) {
      await t.test(`allows ${name} without a token`, () => {
        const result = authorizePreloadRequest(mk('http://myhost.org/api/proxy', headers));
        assert.strictEqual(result.ok, true, `expected ${name} to be allowed`);
      });
    }

    await t.test('denies an unauthenticated plain curl without token or origin', () => {
      const result = authorizePreloadRequest(mk('http://myhost.org/api/proxy', {}));
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.status, 401);
    });
  });
});

test('preload auth — cross-site is rejected before a token is considered', async () => {
  await withToken('correct-horse-battery-staple', () => {
    const result = authorizePreloadRequest(
      mk('http://myhost.org/api/proxy', { 'sec-fetch-site': 'cross-site', 'x-task-token': getTaskToken() })
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 403);
  });
});

test('preload auth — the optional automation token authorizes non-browser callers', async (t) => {
  await withToken('correct-horse-battery-staple', async () => {
    assert.strictEqual(isTaskTokenExplicit(), true);
    assert.strictEqual(getTaskToken(), 'correct-horse-battery-staple');
    assert.strictEqual(isValidTaskToken('correct-horse-battery-staple'), true);
    assert.strictEqual(isValidTaskToken('nope'), false);

    await t.test('accepts the correct token via header', () => {
      const result = authorizePreloadRequest(
        mk('http://myhost.org/api/proxy', { host: 'myhost.org', 'x-task-token': 'correct-horse-battery-staple' })
      );
      assert.strictEqual(result.ok, true);
    });

    await t.test('accepts the correct token via bearer authorization', () => {
      const result = authorizePreloadRequest(
        mk('http://myhost.org/api/proxy', { host: 'myhost.org', authorization: 'Bearer correct-horse-battery-staple' })
      );
      assert.strictEqual(result.ok, true);
    });

    await t.test('rejects a wrong token', () => {
      const result = authorizePreloadRequest(
        mk('http://myhost.org/api/proxy', { host: 'myhost.org', 'x-task-token': 'nope' })
      );
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.status, 403);
    });

    await t.test('a token of the right length but wrong value is rejected', () => {
      const result = authorizePreloadRequest(
        mk('http://myhost.org/api/proxy', {
          'x-task-token': 'correct-horse-battery-staple'.replace('c', 'x')
        })
      );
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.status, 403);
    });

    await t.test('same-origin playback still works without a token', () => {
      // Preload is triggered by ordinary playback. Requiring the operator token
      // here broke cache warm-up for every viewer once the UI stopped storing it.
      const result = authorizePreloadRequest(
        mk('http://myhost.org/api/proxy', { host: 'myhost.org', 'sec-fetch-site': 'same-origin' })
      );
      assert.strictEqual(result.ok, true);
    });
  });
});

test('preload auth — no token is generated when TASK_API_TOKEN is unset', async () => {
  await withToken(undefined, () => {
    assert.strictEqual(isTaskTokenExplicit(), false);
    assert.strictEqual(getTaskToken(), '');
    assert.strictEqual(isValidTaskToken('anything'), false);
  });
});
