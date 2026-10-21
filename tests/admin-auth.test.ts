import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { createScryptHash, parseScryptHash, verifyPasswordAgainstHash } from '@/lib/adminPassword';
import { resetAdminSessionsForTests } from '@/lib/adminSession';
import { resetAdminLoginRateLimitForTests } from '@/lib/adminRateLimit';
import { authorizeAdminRequest } from '@/lib/adminAuth';
import { POST as login } from '@/app/api/admin/login/route';
import { POST as logout } from '@/app/api/admin/logout/route';
import { GET as sessionStatus } from '@/app/api/admin/session/route';

const PASSWORD = 'correct horse battery staple';
const OTHER_PASSWORD = 'a different correct horse';
const HASH = createScryptHash(PASSWORD, { N: 1 << 14 });
const OTHER_HASH = createScryptHash(OTHER_PASSWORD, { N: 1 << 14 });

const ENV_KEYS = [
  'ADMIN_PASSWORD_HASH',
  'ADMIN_PASSWORD_HASH_FILE',
  'ADMIN_PASSWORD_FILE',
  'ADMIN_AUDIT_LOG',
  'ADMIN_ALLOW_INSECURE_HTTP',
  'ADMIN_COOKIE_SECURE',
  'ADMIN_LOGIN_MAX_ATTEMPTS',
  'ADMIN_LOGIN_GLOBAL_FAILURES',
  'ADMIN_ALLOWED_ORIGINS',
  'TASK_API_TOKEN',
  'NODE_ENV',
  'TRUST_PROXY'
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

function configureEnv(overrides: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}): void {
  const env = process.env as Record<string, string | undefined>;
  // A clean, deterministic base. The audit log is off unless a test opts in.
  delete env.ADMIN_PASSWORD_HASH;
  delete env.ADMIN_PASSWORD_HASH_FILE;
  delete env.ADMIN_PASSWORD_FILE;
  delete env.TASK_API_TOKEN;
  env.ADMIN_PASSWORD_HASH = HASH;
  env.ADMIN_AUDIT_LOG = 'off';
  env.ADMIN_ALLOW_INSECURE_HTTP = '1';
  env.ADMIN_COOKIE_SECURE = 'false';
  delete env.ADMIN_LOGIN_MAX_ATTEMPTS;
  delete env.ADMIN_LOGIN_GLOBAL_FAILURES;
  delete env.ADMIN_ALLOWED_ORIGINS;

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }

  resetAdminSessionsForTests();
  resetAdminLoginRateLimitForTests();
}

function loginRequest(
  password: string,
  headers: Record<string, string> = {},
  body = JSON.stringify({ password })
): Request {
  return new Request('http://localhost:8410/api/admin/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:8410',
      'x-admin-request': '1',
      ...headers
    },
    body
  });
}

function sessionCookie(response: Response): string {
  const setCookie = response.headers.get('set-cookie') || '';
  return setCookie.split(';')[0] || '';
}

function withCookie(cookie: string, headers: Record<string, string> = {}): Record<string, string> {
  return { cookie, ...headers };
}

test('admin password — scrypt hashes parse and verify', async () => {
  const parsed = parseScryptHash(HASH);
  assert.strictEqual(parsed.ok, true);
  if (!parsed.ok) return;
  assert.strictEqual(parsed.params.N, 1 << 14);
  assert.strictEqual(parsed.params.r, 8);
  assert.strictEqual(parsed.params.p, 1);
  assert.strictEqual(parsed.params.keylen, 64);

  assert.deepStrictEqual(await verifyPasswordAgainstHash(PASSWORD, HASH), { ok: true });
  assert.deepStrictEqual(await verifyPasswordAgainstHash('wrong', HASH), { ok: false, reason: 'mismatch' });

  const invalid = parseScryptHash('scrypt:1:8:1:64:abc:def');
  assert.strictEqual(invalid.ok, false);
});

test('admin login — CSRF, content type and body checks', async (t) => {
  const env = snapshotEnv();
  configureEnv();
  t.after(() => {
    restoreEnv(env);
    resetAdminSessionsForTests();
    resetAdminLoginRateLimitForTests();
  });

  await t.test('rejects a missing X-Admin-Request header', async () => {
    const res = await login(
      new Request('http://localhost:8410/api/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:8410' },
        body: JSON.stringify({ password: PASSWORD })
      })
    );
    assert.strictEqual(res.status, 403);
  });

  await t.test('rejects a foreign origin', async () => {
    const res = await login(loginRequest(PASSWORD, { origin: 'https://evil.example.com' }));
    assert.strictEqual(res.status, 403);
  });

  await t.test('requires application/json', async () => {
    const res = await login(loginRequest(PASSWORD, { 'content-type': 'text/plain' }));
    assert.strictEqual(res.status, 415);
  });

  await t.test('rejects malformed JSON', async () => {
    const res = await login(loginRequest(PASSWORD, {}, '{not-json'));
    assert.strictEqual(res.status, 400);
  });

  await t.test('rejects a missing password', async () => {
    const res = await login(loginRequest('', {}, JSON.stringify({})));
    assert.strictEqual(res.status, 400);
  });

  await t.test('a malformed explicit origin allowlist fails closed', async () => {
    process.env.ADMIN_ALLOWED_ORIGINS = 'not-a-valid-origin';
    try {
      const res = await login(loginRequest(PASSWORD));
      assert.strictEqual(res.status, 403);
    } finally {
      delete process.env.ADMIN_ALLOWED_ORIGINS;
    }
  });
});

test('admin login/session/logout — happy path and CSRF', async (t) => {
  const env = snapshotEnv();
  configureEnv();
  t.after(() => {
    restoreEnv(env);
    resetAdminSessionsForTests();
    resetAdminLoginRateLimitForTests();
  });

  const loginRes = await login(loginRequest(PASSWORD));
  assert.strictEqual(loginRes.status, 200);
  const body = await loginRes.json();
  assert.strictEqual(body.ok, true);
  assert.strictEqual(typeof body.expiresAt, 'number');
  // Default TTL is 12 hours; guard against an empty env string collapsing it.
  const ttlHours = (body.expiresAt - Date.now()) / (60 * 60 * 1000);
  assert.ok(ttlHours > 11 && ttlHours < 13, `expected a 12h session, got ${ttlHours}h`);

  const setCookie = loginRes.headers.get('set-cookie') || '';
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Max-Age=/);
  assert.match(setCookie, /Path=\//);

  const cookie = sessionCookie(loginRes);
  assert.match(cookie, /^fayun_admin_session=/);

  await t.test('session status reports an authenticated admin', async () => {
    const res = await sessionStatus(
      new Request('http://localhost:8410/api/admin/session', { headers: withCookie(cookie) })
    );
    assert.strictEqual(res.status, 200);
    const status = await res.json();
    assert.strictEqual(status.authenticated, true);
    assert.strictEqual(status.configured, true);
    assert.strictEqual(typeof status.expiresAt, 'number');
  });

  await t.test('admin authorization accepts the session and enforces CSRF', () => {
    const ok = authorizeAdminRequest(
      new Request('http://localhost:8410/api/scan', {
        method: 'POST',
        headers: withCookie(cookie, {
          origin: 'http://localhost:8410',
          'x-admin-request': '1'
        })
      })
    );
    assert.strictEqual(ok.ok, true);
    if (ok.ok) assert.strictEqual(ok.via, 'session');

    const noHeader = authorizeAdminRequest(
      new Request('http://localhost:8410/api/scan', {
        method: 'POST',
        headers: withCookie(cookie, { origin: 'http://localhost:8410' })
      })
    );
    assert.strictEqual(noHeader.ok, false);
    if (!noHeader.ok) assert.strictEqual(noHeader.status, 403);

    const crossSite = authorizeAdminRequest(
      new Request('http://localhost:8410/api/scan', {
        method: 'POST',
        headers: withCookie(cookie, {
          origin: 'http://localhost:8410',
          'x-admin-request': '1',
          'sec-fetch-site': 'cross-site'
        })
      })
    );
    assert.strictEqual(crossSite.ok, false);
    if (!crossSite.ok) assert.strictEqual(crossSite.status, 403);
  });

  await t.test('password rotation invalidates the existing session', async () => {
    process.env.ADMIN_PASSWORD_HASH = OTHER_HASH;
    const res = await sessionStatus(
      new Request('http://localhost:8410/api/admin/session', { headers: withCookie(cookie) })
    );
    const status = await res.json();
    assert.strictEqual(status.authenticated, false);
    assert.strictEqual(status.configured, true);
    process.env.ADMIN_PASSWORD_HASH = HASH;
  });

  await t.test('logout clears the cookie and the server session', async () => {
    const res = await logout(
      new Request('http://localhost:8410/api/admin/logout', {
        method: 'POST',
        headers: withCookie(cookie, {
          origin: 'http://localhost:8410',
          'x-admin-request': '1'
        })
      })
    );
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('set-cookie') || '', /Max-Age=0/);

    const statusRes = await sessionStatus(
      new Request('http://localhost:8410/api/admin/session', { headers: withCookie(cookie) })
    );
    const status = await statusRes.json();
    assert.strictEqual(status.authenticated, false);
  });
});

test('admin login — wrong password and rate limiting', async (t) => {
  const env = snapshotEnv();
  configureEnv({ ADMIN_LOGIN_MAX_ATTEMPTS: '2' });
  t.after(() => {
    restoreEnv(env);
    resetAdminSessionsForTests();
    resetAdminLoginRateLimitForTests();
  });

  const first = await login(loginRequest('wrong-password'));
  assert.strictEqual(first.status, 401);
  const firstBody = await first.json();
  assert.strictEqual(firstBody.code, 'ADMIN_BAD_PASSWORD');

  const second = await login(loginRequest('still-wrong'));
  assert.strictEqual(second.status, 401);

  const limited = await login(loginRequest(PASSWORD));
  assert.strictEqual(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.strictEqual((await limited.json()).code, 'ADMIN_RATE_LIMITED');
});

test('admin login — fails closed when no password is configured', async (t) => {
  const env = snapshotEnv();
  configureEnv({
    ADMIN_PASSWORD_HASH: undefined,
    ADMIN_PASSWORD_FILE: path.join(os.tmpdir(), `missing-admin-${process.pid}.json`),
    ADMIN_AUDIT_LOG: 'off'
  });
  t.after(() => {
    restoreEnv(env);
    resetAdminSessionsForTests();
    resetAdminLoginRateLimitForTests();
  });

  const res = await login(loginRequest(PASSWORD));
  assert.strictEqual(res.status, 503);
  const body = await res.json();
  assert.strictEqual(body.code, 'ADMIN_UNAVAILABLE');
});

test('admin auth — automation token authorizes without a browser session', async (t) => {
  const env = snapshotEnv();
  configureEnv({
    ADMIN_PASSWORD_HASH: undefined,
    ADMIN_PASSWORD_FILE: path.join(os.tmpdir(), `missing-admin-${process.pid}.json`),
    TASK_API_TOKEN: 'script-token'
  });
  t.after(() => {
    restoreEnv(env);
    resetAdminSessionsForTests();
    resetAdminLoginRateLimitForTests();
  });

  const result = authorizeAdminRequest(
    new Request('http://localhost:8410/api/scan', {
      method: 'POST',
      headers: { 'x-task-token': 'script-token' }
    })
  );
  assert.strictEqual(result.ok, true);
  if (result.ok) assert.strictEqual(result.via, 'token');

  const statusRes = await sessionStatus(new Request('http://localhost:8410/api/admin/session'));
  const status = await statusRes.json();
  assert.strictEqual(status.authenticated, false);
  assert.strictEqual(status.configured, false);
  assert.strictEqual(status.tokenConfigured, true);
});

test('admin login — production requires trusted HTTPS and sets a Secure cookie', async (t) => {
  const env = snapshotEnv();
  configureEnv({
    ADMIN_ALLOW_INSECURE_HTTP: undefined,
    ADMIN_COOKIE_SECURE: 'auto',
    NODE_ENV: 'production',
    TRUST_PROXY: '1'
  });
  t.after(() => {
    restoreEnv(env);
    resetAdminSessionsForTests();
    resetAdminLoginRateLimitForTests();
  });

  const cleartext = await login(loginRequest(PASSWORD));
  assert.strictEqual(cleartext.status, 503);
  assert.strictEqual((await cleartext.json()).code, 'ADMIN_HTTPS_REQUIRED');

  const forwardedHttps = await login(
    loginRequest(PASSWORD, {
      origin: 'https://localhost:8410',
      'x-forwarded-host': 'localhost:8410',
      'x-forwarded-proto': 'https'
    })
  );
  assert.strictEqual(forwardedHttps.status, 200);
  assert.match(forwardedHttps.headers.get('set-cookie') || '', /; Secure/);
});

test('admin audit — successful login is recorded without secrets', async (t) => {
  const env = snapshotEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui2-admin-audit-'));
  const logPath = path.join(dir, 'admin.log');
  configureEnv({ ADMIN_AUDIT_LOG: logPath });
  t.after(() => {
    restoreEnv(env);
    resetAdminSessionsForTests();
    resetAdminLoginRateLimitForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const res = await login(loginRequest(PASSWORD));
  assert.strictEqual(res.status, 200);

  const content = fs.readFileSync(logPath, 'utf-8');
  assert.match(content, /event=login_success/);
  assert.ok(!content.includes(PASSWORD), 'the audit log must not contain the password');
  assert.ok(!content.includes(HASH), 'the audit log must not contain the password hash');
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(logPath).mode & 0o777, 0o600);
  }
});
