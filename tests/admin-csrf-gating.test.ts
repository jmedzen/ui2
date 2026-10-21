import './helpers/isolated-media-cache';

import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  createScryptHash,
  writeAdminCredentialFile
} from '@/lib/adminPassword';
import { resetAdminSessionsForTests } from '@/lib/adminSession';
import { resetAdminLoginRateLimitForTests } from '@/lib/adminRateLimit';
import { POST as login } from '@/app/api/admin/login/route';
import { POST as scanPost, GET as scanGet } from '@/app/api/scan/route';

/**
 * CSRF gating for cookie-authenticated maintenance actions.
 *
 * This suite exists because an end-to-end check once asserted "403 without the
 * CSRF header" while reusing a header object that already contained
 * `x-admin-request: 1`. The assertion was wrong, the request was authorized,
 * and a real scan ran against the workspace. Two things changed as a result:
 *
 *   - the positive case is proven here with the scan lock already held, so an
 *     authorized call short-circuits into 409 instead of spawning Python, and
 *   - the negative case is proven with a header set that is guaranteed to lack
 *     the CSRF header rather than one that is merely expected to.
 *
 * `SCAN_LOCK_HOLDER` points at a live pid, so `acquireScanLock()` reports
 * "busy" and the route returns 409. That makes "authorized" observable without
 * any subprocess, network access, or catalog write.
 */

const PASSWORD = 'correct horse battery staple';
const HASH = createScryptHash(PASSWORD, { N: 1 << 14 });
const HOST = 'http://localhost:8410';

const ENV_KEYS = [
  'ADMIN_PASSWORD_HASH',
  'ADMIN_PASSWORD_HASH_FILE',
  'ADMIN_PASSWORD_FILE',
  'ADMIN_TOTP_SECRET',
  'ADMIN_AUDIT_LOG',
  'ADMIN_ALLOW_INSECURE_HTTP',
  'ADMIN_COOKIE_SECURE',
  'ADMIN_SESSION_TTL_MINUTES',
  'ADMIN_LOGIN_MAX_ATTEMPTS',
  'ADMIN_ALLOWED_ORIGINS',
  'TASK_API_TOKEN'
] as const;

type EnvSnapshot = Record<string, string | undefined>;

function snapshotEnv(): EnvSnapshot {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: EnvSnapshot): void {
  const env = process.env as Record<string, string | undefined>;
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

function configure(file: string): void {
  const env = process.env as Record<string, string | undefined>;
  delete env.ADMIN_PASSWORD_HASH;
  delete env.ADMIN_PASSWORD_HASH_FILE;
  delete env.ADMIN_TOTP_SECRET;
  delete env.TASK_API_TOKEN;
  delete env.ADMIN_SESSION_TTL_MINUTES;
  delete env.ADMIN_LOGIN_MAX_ATTEMPTS;
  delete env.ADMIN_ALLOWED_ORIGINS;
  env.ADMIN_PASSWORD_FILE = file;
  env.ADMIN_AUDIT_LOG = 'off';
  env.ADMIN_ALLOW_INSECURE_HTTP = '1';
  env.ADMIN_COOKIE_SECURE = 'false';
  resetAdminSessionsForTests();
  resetAdminLoginRateLimitForTests();
}

function makeCredentialFile(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui2-csrf-'));
  const file = path.join(dir, 'admin.json');
  writeAdminCredentialFile(file, { passwordHash: HASH });
  return { dir, file };
}

/**
 * Plants a lock owned by this (live) process, which is exactly the state the
 * scan route treats as "another maintenance run is in progress".
 */
function holdScanLock(): { release: () => void } {
  const dir = process.env.TASK_LOG_DIR as string;
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, 'scan.lock');
  fs.writeFileSync(
    lockPath,
    JSON.stringify({
      pid: process.pid,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      token: 'csrf-gating-suite'
    })
  );
  return {
    release: () => {
      try {
        fs.unlinkSync(lockPath);
      } catch {}
    }
  };
}

async function loginCookie(): Promise<string> {
  const response = await login(
    new Request(`${HOST}/api/admin/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: HOST,
        'x-admin-request': '1'
      },
      body: JSON.stringify({ password: PASSWORD })
    })
  );
  assert.strictEqual(response.status, 200, await response.clone().text());
  return (response.headers.get('set-cookie') || '').split(';')[0] || '';
}

test('CSRF — a session alone cannot trigger a maintenance action', async (t) => {
  const env = snapshotEnv();
  const { dir, file } = makeCredentialFile();
  configure(file);
  t.after(() => {
    restoreEnv(env);
    resetAdminSessionsForTests();
    resetAdminLoginRateLimitForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const cookie = await loginCookie();
  assert.ok(cookie.startsWith('fayun_admin_session='));

  const lock = holdScanLock();
  t.after(() => lock.release());

  await t.test('no X-Admin-Request header is rejected with 403 before any work starts', async () => {
    // Deliberately constructed from scratch: no shared header object can leak
    // the CSRF header into this request.
    const request = new Request(`${HOST}/api/scan`, {
      method: 'POST',
      headers: { cookie, origin: HOST, 'content-type': 'application/json' }
    });
    assert.strictEqual(request.headers.get('x-admin-request'), null);

    const response = await scanPost(request);
    assert.strictEqual(response.status, 403);
    assert.strictEqual((await response.json()).code, 'ADMIN_CSRF_REJECTED');
  });

  await t.test('a cross-site session request is rejected with 403', async () => {
    const response = await scanPost(
      new Request(`${HOST}/api/scan`, {
        method: 'POST',
        headers: {
          cookie,
          origin: HOST,
          'content-type': 'application/json',
          'x-admin-request': '1',
          'sec-fetch-site': 'cross-site'
        }
      })
    );
    assert.strictEqual(response.status, 403);
    assert.strictEqual((await response.json()).code, 'ADMIN_CSRF_REJECTED');
  });

  await t.test('a foreign Origin is rejected even with the CSRF header', async () => {
    const response = await scanPost(
      new Request(`${HOST}/api/scan`, {
        method: 'POST',
        headers: {
          cookie,
          origin: 'https://evil.example.com',
          'content-type': 'application/json',
          'x-admin-request': '1'
        }
      })
    );
    assert.strictEqual(response.status, 403);
  });

  await t.test('session + CSRF header is authorized (observed as 409, not 403)', async () => {
    // The lock is held, so an authorized request stops at the lock check. Any
    // 403 here would mean the CSRF gate is rejecting a legitimate request.
    const response = await scanPost(
      new Request(`${HOST}/api/scan`, {
        method: 'POST',
        headers: {
          cookie,
          origin: HOST,
          'content-type': 'application/json',
          'x-admin-request': '1'
        }
      })
    );
    assert.strictEqual(response.status, 409, await response.clone().text());
    const body = await response.json();
    assert.strictEqual(body.status, 'busy');
  });

  await t.test('the lock response never includes the ownership token', async () => {
    const response = await scanPost(
      new Request(`${HOST}/api/scan`, {
        method: 'POST',
        headers: {
          cookie,
          origin: HOST,
          'content-type': 'application/json',
          'x-admin-request': '1'
        }
      })
    );
    assert.strictEqual(response.status, 409);
    const body = await response.json();
    assert.strictEqual(typeof body.lockHolder.token, 'undefined');
    assert.ok(!JSON.stringify(body).includes('csrf-gating-suite'));
  });

  await t.test('an anonymous POST is refused with 401, never 409', async () => {
    const response = await scanPost(
      new Request(`${HOST}/api/scan`, {
        method: 'POST',
        headers: { origin: HOST, 'content-type': 'application/json', 'x-admin-request': '1' }
      })
    );
    assert.strictEqual(response.status, 401);
    assert.strictEqual((await response.json()).code, 'ADMIN_LOGIN_REQUIRED');
  });
});

test('CSRF — the read-only status endpoint still gates operational detail', async (t) => {
  const env = snapshotEnv();
  const { dir, file } = makeCredentialFile();
  configure(file);
  t.after(() => {
    restoreEnv(env);
    resetAdminSessionsForTests();
    resetAdminLoginRateLimitForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const lock = holdScanLock();
  t.after(() => lock.release());

  const anonymous = await scanGet(new Request(`${HOST}/api/scan`));
  const anonymousBody = await anonymous.json();
  assert.strictEqual(anonymousBody.logsRestricted, true);
  assert.strictEqual(typeof anonymousBody.recentLogs, 'undefined');
  assert.strictEqual(typeof anonymousBody.lockHolder, 'undefined');
  assert.strictEqual(anonymousBody.isRunning, true);

  const cookie = await loginCookie();
  const authorized = await scanGet(
    new Request(`${HOST}/api/scan`, {
      headers: { cookie, 'sec-fetch-site': 'same-origin' }
    })
  );
  const authorizedBody = await authorized.json();
  assert.strictEqual(authorizedBody.logsRestricted, false);
  assert.strictEqual(typeof authorizedBody.recentLogs, 'string');
  assert.strictEqual(authorizedBody.lockHolder.pid, process.pid);
  assert.strictEqual(typeof authorizedBody.lockHolder.token, 'undefined');
});
