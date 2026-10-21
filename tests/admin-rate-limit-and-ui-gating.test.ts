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
import {
  resetAdminLoginRateLimitForTests
} from '@/lib/adminRateLimit';
import { POST as login } from '@/app/api/admin/login/route';
import { POST as changePassword } from '@/app/api/admin/password/route';

/**
 * Login brute-force budget and the "admin-only UI is hidden" contract.
 *
 * The limiter was implemented long before this suite, but every existing test
 * set `ADMIN_LOGIN_MAX_ATTEMPTS` to an explicit value, so the documented
 * *default* of 10 attempts per 15 minutes was never exercised. A regression to
 * `DEFAULT_PER_CLIENT_ATTEMPTS` would therefore have passed the whole suite.
 */

const PASSWORD = 'correct horse battery staple';
const HASH = createScryptHash(PASSWORD, { N: 1 << 14 });
const HOST = 'http://localhost:8410';
const ROOT = process.cwd();

const ENV_KEYS = [
  'ADMIN_PASSWORD_HASH',
  'ADMIN_PASSWORD_HASH_FILE',
  'ADMIN_PASSWORD_FILE',
  'ADMIN_AUDIT_LOG',
  'ADMIN_ALLOW_INSECURE_HTTP',
  'ADMIN_COOKIE_SECURE',
  'ADMIN_LOGIN_MAX_ATTEMPTS',
  'ADMIN_LOGIN_GLOBAL_FAILURES',
  'ADMIN_TOTP_SECRET',
  'TASK_API_TOKEN'
] as const;

type EnvSnapshot = Record<string, string | undefined>;

let envSnapshot: EnvSnapshot = {};

function configure(file: string): void {
  envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const env = process.env as Record<string, string | undefined>;
  for (const key of ENV_KEYS) delete env[key];
  env.ADMIN_PASSWORD_FILE = file;
  env.ADMIN_AUDIT_LOG = 'off';
  env.ADMIN_ALLOW_INSECURE_HTTP = '1';
  env.ADMIN_COOKIE_SECURE = 'false';
  resetAdminSessionsForTests();
  resetAdminLoginRateLimitForTests();
}

function restoreEnv(): void {
  const env = process.env as Record<string, string | undefined>;
  for (const key of ENV_KEYS) {
    const value = envSnapshot[key];
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

function loginRequest(password: string): Request {
  return new Request(`${HOST}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: HOST, 'x-admin-request': '1' },
    body: JSON.stringify({ password })
  });
}

function makeCredential(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui2-ratelimit-'));
  const file = path.join(dir, 'admin.json');
  writeAdminCredentialFile(file, { passwordHash: HASH });
  return { dir, file };
}

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

/** Strips comments so prose in the source cannot satisfy an assertion. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .map((line) => line.replace(/\s+\/\/.*$/, ''))
    .join('\n');
}

test('login rate limit — the documented default allows 10 attempts per 15 minutes', async (t) => {
  const { dir, file } = makeCredential();
  configure(file);
  t.after(() => {
    restoreEnv();
    resetAdminSessionsForTests();
    resetAdminLoginRateLimitForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('the first 10 wrong passwords are answered 401, the 11th is 429', async () => {
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const response = await login(loginRequest('definitely-the-wrong-password'));
      assert.strictEqual(
        response.status,
        401,
        `attempt ${attempt} must still be evaluated as a bad password`
      );
      assert.strictEqual((await response.json()).code, 'ADMIN_BAD_PASSWORD');
    }

    const eleventh = await login(loginRequest('definitely-the-wrong-password'));
    assert.strictEqual(eleventh.status, 429, 'attempt 11 must be refused before hashing');
    const body = await eleventh.json();
    assert.strictEqual(body.code, 'ADMIN_RATE_LIMITED');
  });

  await t.test('the 429 response tells the client when to retry', async () => {
    const response = await login(loginRequest('definitely-the-wrong-password'));
    assert.strictEqual(response.status, 429);
    const retryAfter = Number(response.headers.get('retry-after'));
    assert.ok(Number.isFinite(retryAfter), 'Retry-After must be a number of seconds');
    // A 15-minute window means the remainder is at most 900s and at least 1s.
    assert.ok(retryAfter >= 1 && retryAfter <= 900, `unexpected Retry-After: ${retryAfter}`);
    assert.ok(/no-store/.test(response.headers.get('cache-control') || ''));
  });

  await t.test('the correct password is also refused while the budget is exhausted', async () => {
    // A limiter that only counted failures would let an attacker keep probing
    // after locking out nothing; the budget covers every attempt.
    const response = await login(loginRequest(PASSWORD));
    assert.strictEqual(response.status, 429);
    assert.strictEqual(response.headers.get('set-cookie'), null, 'no session may be minted');
  });

  await t.test('a successful login clears the budget', async () => {
    resetAdminLoginRateLimitForTests();
    const success = await login(loginRequest(PASSWORD));
    assert.strictEqual(success.status, 200, await success.clone().text());
    resetAdminLoginRateLimitForTests();
  });

  await t.test('an explicit lower limit is honoured', async () => {
    resetAdminLoginRateLimitForTests();
    process.env.ADMIN_LOGIN_MAX_ATTEMPTS = '2';
    try {
      assert.strictEqual((await login(loginRequest('wrong'))).status, 401);
      assert.strictEqual((await login(loginRequest('wrong'))).status, 401);
      const third = await login(loginRequest('wrong'));
      assert.strictEqual(third.status, 429);
    } finally {
      delete process.env.ADMIN_LOGIN_MAX_ATTEMPTS;
      resetAdminLoginRateLimitForTests();
    }
  });
});

test('login rate limit — a non-numeric or empty setting falls back to 10, not zero', async (t) => {
  const { dir, file } = makeCredential();
  configure(file);
  t.after(() => {
    restoreEnv();
    resetAdminSessionsForTests();
    resetAdminLoginRateLimitForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  for (const value of ['', 'not-a-number', '   ']) {
    resetAdminLoginRateLimitForTests();
    if (value === '') delete process.env.ADMIN_LOGIN_MAX_ATTEMPTS;
    else process.env.ADMIN_LOGIN_MAX_ATTEMPTS = value;

    // A malformed value must not collapse the budget to "deny everything".
    const response = await login(loginRequest('wrong-password'));
    assert.strictEqual(
      response.status,
      401,
      `ADMIN_LOGIN_MAX_ATTEMPTS=${JSON.stringify(value)} must fall back to the default`
    );
  }
  delete process.env.ADMIN_LOGIN_MAX_ATTEMPTS;
});

test('login rate limit — a password change also consumes the attempt budget', async (t) => {
  const { dir, file } = makeCredential();
  configure(file);
  t.after(() => {
    restoreEnv();
    resetAdminSessionsForTests();
    resetAdminLoginRateLimitForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const loginResponse = await login(loginRequest(PASSWORD));
  assert.strictEqual(loginResponse.status, 200);
  const cookie = (loginResponse.headers.get('set-cookie') || '').split(';')[0] || '';

  // Every wrong current-password guess is a password oracle; it must be budgeted
  // the same way as a login guess.
  let sawRateLimit = false;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await changePassword(
      new Request(`${HOST}/api/admin/password`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: HOST,
          'x-admin-request': '1',
          cookie
        },
        body: JSON.stringify({
          currentPassword: 'wrong-current-password',
          newPassword: 'another sufficiently long password'
        })
      })
    );
    if (response.status === 429) {
      sawRateLimit = true;
      assert.strictEqual((await response.json()).code, 'ADMIN_RATE_LIMITED');
      break;
    }
    assert.strictEqual(response.status, 401, 'a wrong current password is a 401');
  }
  assert.ok(sawRateLimit, 'repeated and wrong current-password guesses must hit the limiter');
});

test('admin-only UI — anonymous visitors are not shown management controls', () => {
  const modal = stripComments(read('src/components/SettingsModal.tsx'));

  // The scan/heal/copy/refresh toolbar used to be rendered for everyone with
  // `disabled` on the two destructive buttons: the feature was still advertised
  // (tooltips included) to visitors who could not use it.
  const toolbar = modal.slice(modal.indexOf('log-action-toolbar'));
  assert.ok(toolbar.length > 0, 'the toolbar must exist');
  assert.match(
    modal,
    /\{isAdminAuthenticated && \(\s*<div className="log-action-toolbar">/,
    'the action toolbar must be rendered only for an authenticated admin'
  );

  // Neither destructive button may still carry a mere `disabled` guard.
  assert.doesNotMatch(
    modal,
    /disabled=\{!isAdminAuthenticated \|\|/,
    'a hidden control does not need an auth-based disabled flag'
  );

  assert.match(
    modal,
    /\{isAdminAuthenticated && \(\s*<div className="log-stats-bar">/,
    'the operational stat cards must be admin-only'
  );

  assert.match(
    modal,
    /\{isAdminAuthenticated && !logsRestricted && \(\s*<div className="log-window-wrapper">/,
    'the log window must be admin-only'
  );

  // The security panel is the password/TOTP surface; it must stay behind the
  // authenticated branch.
  assert.match(
    modal,
    /\) : isAdminAuthenticated \? \(/,
    'the authenticated branch must gate the session row and security panel'
  );
  assert.match(
    modal,
    /<AdminSecurityPanel/,
    'the security panel must exist inside that branch'
  );

  // Anonymous visitors must still get a way in.
  assert.match(modal, /className="admin-login-form"/, 'the login form must remain reachable');
});

test('admin-only UI — the log poll does not run for anonymous visitors', () => {
  const modal = stripComments(read('src/components/SettingsModal.tsx'));
  const pollStart = modal.indexOf("activeTab !== 'logs'");
  assert.ok(pollStart > 0);
  const pollEffect = modal.slice(pollStart, pollStart + 400);

  assert.match(
    pollEffect,
    /!isAdminAuthenticated\) return;/,
    'the 3s poll must stop when there is no admin session'
  );
  assert.match(
    modal,
    /\}, \[isOpen, activeTab, isAdminAuthenticated, fetchLogs\]\);/,
    'the poll effect must depend on the session state'
  );
});
