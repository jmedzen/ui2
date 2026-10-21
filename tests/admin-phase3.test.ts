import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  createScryptHash,
  readAdminCredential,
  verifyPasswordAgainstHash,
  writeAdminCredentialFile
} from '@/lib/adminPassword';
import { resetAdminSessionsForTests } from '@/lib/adminSession';
import { resetAdminLoginRateLimitForTests } from '@/lib/adminRateLimit';
import {
  TOTP_PERIOD_SECONDS,
  generateTotpCode,
  generateTotpSecret,
  resetTotpReplayForTests
} from '@/lib/totp';
import { POST as login } from '@/app/api/admin/login/route';
import { POST as logout } from '@/app/api/admin/logout/route';
import { POST as changePassword } from '@/app/api/admin/password/route';
import { POST as manageTotp } from '@/app/api/admin/totp/route';
import { GET as sessionStatus } from '@/app/api/admin/session/route';

const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a new sufficiently long password';
const HASH = createScryptHash(PASSWORD, { N: 1 << 14 });

const ENV_KEYS = [
  'ADMIN_PASSWORD_HASH',
  'ADMIN_PASSWORD_HASH_FILE',
  'ADMIN_PASSWORD_FILE',
  'ADMIN_TOTP_SECRET',
  'ADMIN_TOTP_WINDOW',
  'ADMIN_AUDIT_LOG',
  'ADMIN_ALLOW_INSECURE_HTTP',
  'ADMIN_COOKIE_SECURE',
  'ADMIN_LOGIN_MAX_ATTEMPTS',
  'ADMIN_ALLOWED_ORIGINS',
  'TASK_API_TOKEN',
  'NODE_ENV'
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
  delete env.ADMIN_TOTP_WINDOW;
  delete env.ADMIN_LOGIN_MAX_ATTEMPTS;
  delete env.ADMIN_ALLOWED_ORIGINS;
  delete env.TASK_API_TOKEN;
  env.ADMIN_PASSWORD_FILE = file;
  env.ADMIN_AUDIT_LOG = 'off';
  env.ADMIN_ALLOW_INSECURE_HTTP = '1';
  env.ADMIN_COOKIE_SECURE = 'false';
  resetAdminSessionsForTests();
  resetAdminLoginRateLimitForTests();
  resetTotpReplayForTests();
}

function headers(cookie = '', extra: Record<string, string> = {}): Record<string, string> {
  return {
    'content-type': 'application/json',
    origin: 'http://localhost:8410',
    'x-admin-request': '1',
    ...(cookie ? { cookie } : {}),
    ...extra
  };
}

function loginRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost:8410/api/admin/login', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body)
  });
}

function sessionCookie(response: Response): string {
  return (response.headers.get('set-cookie') || '').split(';')[0] || '';
}

function postWithCookie(
  url: string,
  cookie: string,
  body: Record<string, unknown>
): Request {
  return new Request(url, {
    method: 'POST',
    headers: headers(cookie),
    body: JSON.stringify(body)
  });
}

function errorCode(body: { code?: unknown }): string {
  return typeof body.code === 'string' ? body.code : '';
}

function codeForNextStep(): string {
  return generateTotpCode(
    // The caller passes the secret through the closure below; this helper is
    // only used by the management test which has exactly one secret.
    currentManagementSecret,
    Date.now() + TOTP_PERIOD_SECONDS * 1000
  );
}

let currentManagementSecret = '';

async function loginWithPassword(): Promise<string> {
  const response = await login(loginRequest({ password: PASSWORD }));
  assert.strictEqual(response.status, 200, await response.clone().text());
  return sessionCookie(response);
}

test('admin Phase 3 — password change writes a new hash, preserves TOTP and rotates sessions', async (t) => {
  const env = snapshotEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui2-phase3-password-'));
  const file = path.join(dir, 'admin.json');
  const totpSecret = generateTotpSecret();
  writeAdminCredentialFile(file, { passwordHash: HASH, totpSecret });
  configure(file);

  t.after(() => {
    restoreEnv(env);
    resetAdminSessionsForTests();
    resetAdminLoginRateLimitForTests();
    resetTotpReplayForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Login normally to establish a session, then change the password without a
  // TOTP code first: the route must demand it.
  const codeResponse = await login(loginRequest({ password: PASSWORD }));
  assert.strictEqual(codeResponse.status, 401);
  assert.strictEqual(errorCode(await codeResponse.json()), 'ADMIN_TOTP_REQUIRED');

  const currentCode = generateTotpCode(totpSecret);
  const loginResponse = await login(loginRequest({ password: PASSWORD, code: currentCode }));
  assert.strictEqual(loginResponse.status, 200, await loginResponse.clone().text());
  const oldCookie = sessionCookie(loginResponse);

  const missingCode = await changePassword(
    postWithCookie('http://localhost:8410/api/admin/password', oldCookie, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD
    })
  );
  assert.strictEqual(missingCode.status, 401);
  assert.strictEqual(errorCode(await missingCode.json()), 'ADMIN_TOTP_REQUIRED');

  const nextCode = generateTotpCode(
    totpSecret,
    Date.now() + TOTP_PERIOD_SECONDS * 1000
  );
  const changed = await changePassword(
    postWithCookie('http://localhost:8410/api/admin/password', oldCookie, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
      code: nextCode
    })
  );
  assert.strictEqual(changed.status, 200, await changed.clone().text());
  const freshCookie = sessionCookie(changed);
  assert.ok(freshCookie);
  assert.notStrictEqual(freshCookie, oldCookie);

  const oldSession = await sessionStatus(
    new Request('http://localhost:8410/api/admin/session', { headers: { cookie: oldCookie } })
  );
  assert.strictEqual((await oldSession.json()).authenticated, false);

  const freshSession = await sessionStatus(
    new Request('http://localhost:8410/api/admin/session', { headers: { cookie: freshCookie } })
  );
  const status = await freshSession.json();
  assert.strictEqual(status.authenticated, true);
  assert.strictEqual(status.passwordChangeable, true);
  assert.strictEqual(status.totpEnabled, true);
  assert.strictEqual(status.totpManageable, true);

  const credential = readAdminCredential();
  assert.strictEqual(credential.ok, true);
  if (!credential.ok) return;
  assert.strictEqual(await verifyPasswordAgainstHash(PASSWORD, credential.hash).then((r) => r.ok), false);
  assert.strictEqual(await verifyPasswordAgainstHash(NEW_PASSWORD, credential.hash).then((r) => r.ok), true);
  assert.strictEqual(credential.totpSecret, totpSecret, 'password rotation must preserve 2FA');
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  }
});

test('admin Phase 3 — password change is refused for environment-managed credentials', async (t) => {
  const env = snapshotEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui2-phase3-env-'));
  const file = path.join(dir, 'admin.json');
  configure(file);
  process.env.ADMIN_PASSWORD_HASH = HASH;

  t.after(() => {
    restoreEnv(env);
    resetAdminSessionsForTests();
    resetAdminLoginRateLimitForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const cookie = await loginWithPassword();
  const response = await changePassword(
    postWithCookie('http://localhost:8410/api/admin/password', cookie, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD
    })
  );
  assert.strictEqual(response.status, 409);
  assert.strictEqual(errorCode(await response.json()), 'ADMIN_PASSWORD_MANAGED_EXTERNALLY');
  assert.strictEqual(fs.existsSync(file), false, 'the route must not create a file');
});

test('admin Phase 3 — TOTP setup, enable and disable update the credential file', async (t) => {
  const env = snapshotEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui2-phase3-totp-'));
  const file = path.join(dir, 'admin.json');
  writeAdminCredentialFile(file, { passwordHash: HASH });
  configure(file);

  t.after(() => {
    restoreEnv(env);
    resetAdminSessionsForTests();
    resetAdminLoginRateLimitForTests();
    resetTotpReplayForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const cookie = await loginWithPassword();

  const setup = await manageTotp(
    postWithCookie('http://localhost:8410/api/admin/totp', cookie, { action: 'setup' })
  );
  assert.strictEqual(setup.status, 200, await setup.clone().text());
  const setupBody = await setup.json();
  assert.strictEqual(typeof setupBody.secret, 'string');
  assert.match(String(setupBody.otpauthUri), /^otpauth:\/\/totp\//);
  currentManagementSecret = String(setupBody.secret);

  const enableCode = generateTotpCode(currentManagementSecret);
  const enabled = await manageTotp(
    postWithCookie('http://localhost:8410/api/admin/totp', cookie, {
      action: 'enable',
      secret: currentManagementSecret,
      code: enableCode,
      password: PASSWORD
    })
  );
  assert.strictEqual(enabled.status, 200, await enabled.clone().text());

  const afterEnable = readAdminCredential();
  assert.strictEqual(afterEnable.ok, true);
  if (afterEnable.ok) assert.strictEqual(afterEnable.totpSecret, currentManagementSecret);

  const statusAfterEnable = await sessionStatus(
    new Request('http://localhost:8410/api/admin/session', { headers: { cookie } })
  );
  const statusBody = await statusAfterEnable.json();
  assert.strictEqual(statusBody.totpEnabled, true);
  assert.strictEqual(statusBody.totpManageable, true);

  // The code used to enable was consumed; use the next timestep to disable.
  const disableCode = codeForNextStep();
  const disabled = await manageTotp(
    postWithCookie('http://localhost:8410/api/admin/totp', cookie, {
      action: 'disable',
      code: disableCode,
      password: PASSWORD
    })
  );
  assert.strictEqual(disabled.status, 200, await disabled.clone().text());

  const afterDisable = readAdminCredential();
  assert.strictEqual(afterDisable.ok, true);
  if (afterDisable.ok) assert.strictEqual(afterDisable.totpSecret, undefined);

  const statusAfterDisable = await sessionStatus(
    new Request('http://localhost:8410/api/admin/session', { headers: { cookie } })
  );
  assert.strictEqual((await statusAfterDisable.json()).totpEnabled, false);
});

test('admin Phase 3 — TOTP login is two-step and rejects a replayed code', async (t) => {
  const env = snapshotEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui2-phase3-login-'));
  const file = path.join(dir, 'admin.json');
  const secret = generateTotpSecret();
  writeAdminCredentialFile(file, { passwordHash: HASH, totpSecret: secret });
  configure(file);

  t.after(() => {
    restoreEnv(env);
    resetAdminSessionsForTests();
    resetAdminLoginRateLimitForTests();
    resetTotpReplayForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const missing = await login(loginRequest({ password: PASSWORD }));
  assert.strictEqual(missing.status, 401);
  assert.strictEqual(errorCode(await missing.json()), 'ADMIN_TOTP_REQUIRED');

  const code = generateTotpCode(secret);
  const success = await login(loginRequest({ password: PASSWORD, code }));
  assert.strictEqual(success.status, 200, await success.clone().text());

  const replay = await login(loginRequest({ password: PASSWORD, code }));
  assert.strictEqual(replay.status, 401);
  assert.strictEqual(errorCode(await replay.json()), 'ADMIN_TOTP_REPLAY');
});

test('admin Phase 3 — ADMIN_TOTP_SECRET overrides the file and is not UI-manageable', async (t) => {
  const env = snapshotEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui2-phase3-envtotp-'));
  const file = path.join(dir, 'admin.json');
  const envSecret = generateTotpSecret();
  writeAdminCredentialFile(file, { passwordHash: HASH });
  configure(file);
  process.env.ADMIN_TOTP_SECRET = envSecret;

  t.after(() => {
    restoreEnv(env);
    resetAdminSessionsForTests();
    resetAdminLoginRateLimitForTests();
    resetTotpReplayForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const missing = await login(loginRequest({ password: PASSWORD }));
  assert.strictEqual(missing.status, 401);
  assert.strictEqual(errorCode(await missing.json()), 'ADMIN_TOTP_REQUIRED');

  const code = generateTotpCode(envSecret);
  const success = await login(loginRequest({ password: PASSWORD, code }));
  assert.strictEqual(success.status, 200, await success.clone().text());
  const cookie = sessionCookie(success);

  const status = await sessionStatus(
    new Request('http://localhost:8410/api/admin/session', { headers: { cookie } })
  );
  const statusBody = await status.json();
  assert.strictEqual(statusBody.totpEnabled, true);
  assert.strictEqual(statusBody.totpManageable, false);

  const setup = await manageTotp(
    postWithCookie('http://localhost:8410/api/admin/totp', cookie, { action: 'setup' })
  );
  assert.strictEqual(setup.status, 409);
  assert.strictEqual(errorCode(await setup.json()), 'ADMIN_TOTP_MANAGED_EXTERNALLY');

  await logout(
    new Request('http://localhost:8410/api/admin/logout', {
      method: 'POST',
      headers: headers(cookie)
    })
  );
});
