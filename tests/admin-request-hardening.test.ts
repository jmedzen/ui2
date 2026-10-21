import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { createScryptHash, writeAdminCredentialFile } from '@/lib/adminPassword';
import { resetAdminSessionsForTests } from '@/lib/adminSession';
import { resetAdminLoginRateLimitForTests } from '@/lib/adminRateLimit';
import { POST as login } from '@/app/api/admin/login/route';
import { POST as changePassword } from '@/app/api/admin/password/route';
import { POST as logout } from '@/app/api/admin/logout/route';

/**
 * Request hardening for the credential endpoints: bounded bodies and an audit
 * trail that records the event without ever recording the secret.
 *
 * Both properties are security-relevant and both were previously unverified:
 * an unbounded JSON body on the login route is a trivial memory/CPU lever, and
 * an audit line that echoed a submitted password would persist it in a file
 * nobody thinks of as sensitive.
 */

const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a brand new long password';
const HASH = createScryptHash(PASSWORD, { N: 1 << 14 });
const HOST = 'http://localhost:8410';

const ENV_KEYS = [
  'ADMIN_PASSWORD_HASH',
  'ADMIN_PASSWORD_HASH_FILE',
  'ADMIN_PASSWORD_FILE',
  'ADMIN_AUDIT_LOG',
  'ADMIN_AUDIT_MAX_BYTES',
  'ADMIN_AUDIT_MAX_FILES',
  'ADMIN_ALLOW_INSECURE_HTTP',
  'ADMIN_COOKIE_SECURE',
  'ADMIN_TOTP_SECRET',
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

function configure(file: string, auditLog: string): void {
  const env = process.env as Record<string, string | undefined>;
  for (const key of ENV_KEYS) delete env[key];
  env.ADMIN_PASSWORD_FILE = file;
  env.ADMIN_AUDIT_LOG = auditLog;
  env.ADMIN_ALLOW_INSECURE_HTTP = '1';
  env.ADMIN_COOKIE_SECURE = 'false';
  resetAdminSessionsForTests();
  resetAdminLoginRateLimitForTests();
}

function post(route: string, body: unknown, extra: Record<string, string> = {}): Request {
  return new Request(`${HOST}${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: HOST,
      'x-admin-request': '1',
      'user-agent': 'ui2-hardening-suite/1.0',
      ...extra
    },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

test('admin requests — oversized bodies are refused before they are buffered', async (t) => {
  const env = snapshotEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui2-bodylimit-'));
  const file = path.join(dir, 'admin.json');
  writeAdminCredentialFile(file, { passwordHash: HASH });
  configure(file, 'off');
  t.after(() => {
    restoreEnv(env);
    resetAdminSessionsForTests();
    resetAdminLoginRateLimitForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('login rejects a body over 4 KB with 413', async () => {
    const huge = JSON.stringify({ password: `${PASSWORD}${'x'.repeat(8192)}` });
    const response = await login(post('/api/admin/login', huge));
    assert.strictEqual(response.status, 413);
    assert.strictEqual((await response.json()).code, 'ADMIN_BAD_BODY');
  });

  await t.test('an over-long password is a 400, not a scrypt run', async () => {
    const response = await login(
      post('/api/admin/login', { password: 'y'.repeat(300) })
    );
    assert.strictEqual(response.status, 400);
    assert.strictEqual((await response.json()).code, 'ADMIN_PASSWORD_TOO_LONG');
  });

  await t.test('a non-object JSON body is treated as a missing password', async () => {
    const response = await login(post('/api/admin/login', '"just-a-string"'));
    assert.strictEqual(response.status, 400);
    assert.strictEqual((await response.json()).code, 'ADMIN_PASSWORD_REQUIRED');
  });

  await t.test('the automation token alone cannot log in', async () => {
    process.env.TASK_API_TOKEN = 'hardening-script-token';
    try {
      // A valid token with no password must not mint a session: the token is an
      // automation shortcut for maintenance endpoints, not a login credential.
      const noPassword = await login(
        post('/api/admin/login', {}, { 'x-task-token': 'hardening-script-token' })
      );
      assert.strictEqual(noPassword.status, 400);
      assert.strictEqual((await noPassword.json()).code, 'ADMIN_PASSWORD_REQUIRED');
      assert.strictEqual(noPassword.headers.get('set-cookie'), null);

      const wrongPassword = await login(
        post(
          '/api/admin/login',
          { password: 'still-the-wrong-password' },
          { 'x-task-token': 'hardening-script-token' }
        )
      );
      assert.strictEqual(wrongPassword.status, 401);
      assert.strictEqual((await wrongPassword.json()).code, 'ADMIN_BAD_PASSWORD');
      assert.strictEqual(wrongPassword.headers.get('set-cookie'), null);
    } finally {
      delete process.env.TASK_API_TOKEN;
    }
  });
});

test('admin audit — events are recorded without the password, hash or session token', async (t) => {
  const env = snapshotEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui2-audit-secrecy-'));
  const file = path.join(dir, 'admin.json');
  const auditPath = path.join(dir, 'admin.log');
  writeAdminCredentialFile(file, { passwordHash: HASH });
  configure(file, auditPath);
  t.after(() => {
    restoreEnv(env);
    resetAdminSessionsForTests();
    resetAdminLoginRateLimitForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const failed = await login(post('/api/admin/login', { password: 'definitely-wrong' }));
  assert.strictEqual(failed.status, 401);

  const success = await login(post('/api/admin/login', { password: PASSWORD }));
  assert.strictEqual(success.status, 200);
  const cookie = (success.headers.get('set-cookie') || '').split(';')[0] || '';
  const sessionToken = cookie.slice(cookie.indexOf('=') + 1);

  const changed = await changePassword(
    post(
      '/api/admin/password',
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      { cookie }
    )
  );
  assert.strictEqual(changed.status, 200, await changed.clone().text());

  await logout(post('/api/admin/logout', {}, { cookie }));

  const log = fs.readFileSync(auditPath, 'utf-8');
  assert.match(log, /login_failure/, 'the failed attempt must be recorded');
  assert.match(log, /login_success/, 'the successful login must be recorded');
  assert.match(log, /password_change/, 'the rotation must be recorded');
  assert.match(log, /logout/, 'the logout must be recorded');

  for (const secret of [PASSWORD, NEW_PASSWORD, HASH, sessionToken, 'definitely-wrong']) {
    if (!secret) continue;
    assert.ok(
      !log.includes(secret),
      `the audit log must never contain a secret; leaked: ${secret.slice(0, 12)}…`
    );
  }
  assert.ok(!log.includes(dir), 'the audit log must not contain the credential file path');

  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(auditPath).mode & 0o777, 0o600);
  }
});
