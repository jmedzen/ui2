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
import { POST as logout } from '@/app/api/admin/logout/route';
import { GET as sessionStatus } from '@/app/api/admin/session/route';
import { GET as getTotp } from '@/app/api/admin/totp/route';
import { POST as changePassword } from '@/app/api/admin/password/route';
import { GET as getScan } from '@/app/api/scan/route';

/**
 * Phase 2 verification: the browser talks to the admin session API only, the
 * old localStorage automation token is gone, logs are gated server-side, and
 * preload cache warm-up is decoupled from admin authentication.
 *
 * The behavioural half reuses the real route handlers rather than asserting on
 * comments, so these tests fail if the gating is removed from the server.
 */

const ROOT = process.cwd();
const PASSWORD = 'correct horse battery staple';
const OTHER_PASSWORD = 'a different correct horse';
const HASH = createScryptHash(PASSWORD, { N: 1 << 14 });
const OTHER_HASH = createScryptHash(OTHER_PASSWORD, { N: 1 << 14 });
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

function configure(file: string, overrides: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}): void {
  const env = process.env as Record<string, string | undefined>;
  delete env.ADMIN_PASSWORD_HASH;
  delete env.ADMIN_PASSWORD_HASH_FILE;
  delete env.ADMIN_PASSWORD_FILE;
  delete env.ADMIN_TOTP_SECRET;
  delete env.TASK_API_TOKEN;
  delete env.ADMIN_SESSION_TTL_MINUTES;
  delete env.ADMIN_LOGIN_MAX_ATTEMPTS;
  delete env.ADMIN_ALLOWED_ORIGINS;
  env.ADMIN_PASSWORD_FILE = file;
  env.ADMIN_AUDIT_LOG = 'off';
  env.ADMIN_ALLOW_INSECURE_HTTP = '1';
  env.ADMIN_COOKIE_SECURE = 'false';
  env.NODE_ENV = 'test';

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }

  resetAdminSessionsForTests();
  resetAdminLoginRateLimitForTests();
}

function makeCredentialFile(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui2-phase2-'));
  const file = path.join(dir, 'admin.json');
  writeAdminCredentialFile(file, { passwordHash: HASH });
  return { dir, file };
}

function browserHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'content-type': 'application/json',
    origin: HOST,
    'x-admin-request': '1',
    ...extra
  };
}

function loginRequest(password: string): Request {
  return new Request(`${HOST}/api/admin/login`, {
    method: 'POST',
    headers: browserHeaders(),
    body: JSON.stringify({ password })
  });
}

function sessionCookie(response: Response): string {
  return (response.headers.get('set-cookie') || '').split(';')[0] || '';
}

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

/** Strips comments so prose cannot satisfy a source assertion. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .map((line) => line.replace(/\s+\/\/.*$/, ''))
    .join('\n');
}

test('admin Phase 2 — the browser uses password sessions, never the automation token', async (t) => {
  await t.test('the settings modal logs in through the session API', () => {
    const code = stripComments(read('src/components/SettingsModal.tsx'));

    assert.match(code, /\/api\/admin\/login/, 'login must go through the password endpoint');
    assert.match(code, /\/api\/admin\/session/, 'the modal must read session status');
    assert.match(code, /\/api\/admin\/logout/, 'logout must revoke the server session');
    assert.match(code, /type="password"/, 'the login field must be a password input');
    assert.match(code, /autoComplete="current-password"/);
    assert.match(code, /'X-Admin-Request': '1'/, 'state-changing admin calls need the CSRF header');
    assert.match(code, /credentials: 'same-origin'/, 'the session cookie must be sent');
  });

  await t.test('the stale localStorage token is removed and never read or written', () => {
    const code = stripComments(read('src/components/SettingsModal.tsx'));

    assert.match(
      code,
      /localStorage\.removeItem\('fayun_task_token'\)/,
      'upgrading browsers must delete the old token'
    );
    assert.doesNotMatch(
      code,
      /localStorage\.(getItem|setItem)\('fayun_task_token'/,
      'the old token must never be restored or persisted'
    );
    assert.doesNotMatch(code, /x-task-token/i, 'the browser must not present the automation token');
    assert.doesNotMatch(code, /authorization/i, 'the browser must not build an Authorization header');
  });

  await t.test('log visibility follows the server gate, not a client-side flag', () => {
    const code = stripComments(read('src/components/SettingsModal.tsx'));

    assert.match(code, /data\.logsRestricted/, 'the modal must read the server restriction flag');
    assert.match(code, /logsRestricted/, 'the log pane state must exist');
    assert.match(
      code,
      /disabled=\{logsRestricted \|\| !logs\}/,
      'copy must be disabled while logs are restricted'
    );
    assert.match(code, /🔒 管理員登入後即可查看/, 'restricted logs must show a login prompt');
  });

  await t.test('the security panel exposes Phase 3 password and TOTP management', () => {
    const code = stripComments(read('src/components/AdminSecurityPanel.tsx'));

    assert.match(code, /\/api\/admin\/password/);
    assert.match(code, /\/api\/admin\/totp/);
    assert.match(code, /action: 'setup'/);
    assert.match(code, /action: 'enable'/);
    assert.match(code, /action: 'disable'/);
    assert.match(code, /type="password"/);
  });

  await t.test('preload warm-up stays independent of admin authentication', () => {
    const code = stripComments(read('src/lib/speedTester.ts'));
    const preload = code.slice(code.indexOf('export function triggerBackgroundServerCache'));

    assert.match(preload, /method: 'POST'/, 'preload must be an explicit POST');
    assert.match(preload, /credentials: 'same-origin'/);
    assert.match(preload, /action=preload/);
    assert.doesNotMatch(preload, /admin/i, 'playback warm-up must not depend on an admin session');
    assert.doesNotMatch(preload, /x-task-token/i);
    assert.doesNotMatch(preload, /authorization/i);
  });
});

test('admin Phase 2 — scan logs are gated by a live session or automation token', async (t) => {
  const env = snapshotEnv();
  const { dir, file } = makeCredentialFile();
  configure(file);
  t.after(() => {
    restoreEnv(env);
    resetAdminSessionsForTests();
    resetAdminLoginRateLimitForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('anonymous status hides recentLogs and lockHolder', async () => {
    const response = await getScan(new Request(`${HOST}/api/scan`));
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.logsRestricted, true);
    assert.strictEqual(typeof body.recentLogs, 'undefined');
    assert.strictEqual(typeof body.lockHolder, 'undefined');
  });

  await t.test('an authenticated session reveals the log tail', async () => {
    const loginResponse = await login(loginRequest(PASSWORD));
    assert.strictEqual(loginResponse.status, 200);
    const cookie = sessionCookie(loginResponse);

    const response = await getScan(
      new Request(`${HOST}/api/scan`, { headers: { cookie } })
    );
    const body = await response.json();
    assert.strictEqual(body.logsRestricted, false);
    assert.strictEqual(typeof body.recentLogs, 'string');
  });

  await t.test('an automation token also reveals the log tail', async () => {
    process.env.TASK_API_TOKEN = 'phase2-script-token';
    const response = await getScan(
      new Request(`${HOST}/api/scan`, {
        headers: { 'x-task-token': 'phase2-script-token' }
      })
    );
    const body = await response.json();
    assert.strictEqual(body.logsRestricted, false);
    assert.strictEqual(typeof body.recentLogs, 'string');
  });

  await t.test('a cross-site request is treated as anonymous', async () => {
    const loginResponse = await login(loginRequest(PASSWORD));
    const cookie = sessionCookie(loginResponse);

    const response = await getScan(
      new Request(`${HOST}/api/scan`, {
        headers: { cookie, 'sec-fetch-site': 'cross-site' }
      })
    );
    const body = await response.json();
    assert.strictEqual(body.logsRestricted, true);
    assert.strictEqual(typeof body.recentLogs, 'undefined');
  });
});

test('admin Phase 2 — session status clears dead cookies and never leaks secrets', async (t) => {
  const env = snapshotEnv();
  const { dir, file } = makeCredentialFile();
  configure(file);
  t.after(() => {
    restoreEnv(env);
    resetAdminSessionsForTests();
    resetAdminLoginRateLimitForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const loginResponse = await login(loginRequest(PASSWORD));
  assert.strictEqual(loginResponse.status, 200);
  const cookie = sessionCookie(loginResponse);

  const statusResponse = await sessionStatus(
    new Request(`${HOST}/api/admin/session`, { headers: { cookie } })
  );
  const status = await statusResponse.json();
  const serialized = JSON.stringify(status);

  assert.strictEqual(status.authenticated, true);
  assert.strictEqual(status.passwordChangeable, true);
  assert.ok(!serialized.includes(HASH), 'the hash must never reach the browser');
  assert.ok(!serialized.includes(file), 'the credential file path must never reach the browser');
  assert.ok(!serialized.includes(PASSWORD), 'the password must never reach the browser');

  // Rotating the password makes the fingerprint mismatch. The endpoint must
  // both report "logged out" and instruct the browser to drop the cookie.
  process.env.ADMIN_PASSWORD_HASH = OTHER_HASH;
  const rotated = await sessionStatus(
    new Request(`${HOST}/api/admin/session`, { headers: { cookie } })
  );
  const rotatedBody = await rotated.json();
  assert.strictEqual(rotatedBody.authenticated, false);
  assert.match(rotated.headers.get('set-cookie') || '', /Max-Age=0/);
});

test('admin Phase 2 — session TTL is configurable and clamped', async (t) => {
  const env = snapshotEnv();
  const { dir, file } = makeCredentialFile();
  configure(file, { ADMIN_SESSION_TTL_MINUTES: '1' });
  t.after(() => {
    restoreEnv(env);
    resetAdminSessionsForTests();
    resetAdminLoginRateLimitForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const shortResponse = await login(loginRequest(PASSWORD));
  assert.strictEqual(shortResponse.status, 200);
  const shortMinutes = ((await shortResponse.json()).expiresAt - Date.now()) / 60000;
  assert.ok(shortMinutes >= 4.5 && shortMinutes <= 5.5, `expected the 5-minute floor, got ${shortMinutes}`);

  process.env.ADMIN_SESSION_TTL_MINUTES = '999999';
  resetAdminSessionsForTests();
  resetAdminLoginRateLimitForTests();
  const longResponse = await login(loginRequest(PASSWORD));
  assert.strictEqual(longResponse.status, 200);
  const longMinutes = ((await longResponse.json()).expiresAt - Date.now()) / 60000;
  assert.ok(longMinutes >= 7 * 24 * 60 - 1, `expected the 7-day ceiling, got ${longMinutes}`);
});

test('admin Phase 2 — logout is idempotent and password/TOTP management require a session', async (t) => {
  const env = snapshotEnv();
  const { dir, file } = makeCredentialFile();
  configure(file, { TASK_API_TOKEN: 'phase2-script-token' });
  t.after(() => {
    restoreEnv(env);
    resetAdminSessionsForTests();
    resetAdminLoginRateLimitForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('logging out without a cookie still clears browser state', async () => {
    const response = await logout(
      new Request(`${HOST}/api/admin/logout`, { method: 'POST', headers: browserHeaders() })
    );
    assert.strictEqual(response.status, 200);
    assert.strictEqual((await response.json()).ok, true);
    assert.match(response.headers.get('set-cookie') || '', /Max-Age=0/);
  });

  await t.test('the automation token cannot change the password', async () => {
    const response = await changePassword(
      new Request(`${HOST}/api/admin/password`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-task-token': 'phase2-script-token'
        },
        body: JSON.stringify({
          currentPassword: PASSWORD,
          newPassword: 'another sufficiently long password'
        })
      })
    );
    assert.strictEqual(response.status, 401);
    assert.strictEqual((await response.json()).code, 'ADMIN_LOGIN_REQUIRED');
  });

  await t.test('TOTP status is not readable without a browser session', async () => {
    const anonymous = await getTotp(new Request(`${HOST}/api/admin/totp`));
    assert.strictEqual(anonymous.status, 401);

    const tokenOnly = await getTotp(
      new Request(`${HOST}/api/admin/totp`, {
        headers: { 'x-task-token': 'phase2-script-token' }
      })
    );
    assert.strictEqual(tokenOnly.status, 401);
  });
});
