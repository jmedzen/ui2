import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  MAX_ADMIN_PASSWORD_LENGTH,
  MIN_ADMIN_PASSWORD_LENGTH
} from '@/lib/passwordPolicy';
import {
  createScryptHash,
  readAdminCredential,
  validateAdminPassword,
  verifyPasswordAgainstHash,
  writeAdminCredentialFile
} from '@/lib/adminPassword';
import { resetAdminSessionsForTests } from '@/lib/adminSession';
import { resetAdminLoginRateLimitForTests } from '@/lib/adminRateLimit';
import { POST as login } from '@/app/api/admin/login/route';
import { POST as changePassword } from '@/app/api/admin/password/route';

/**
 * The password length floor must be one number, not three.
 *
 * It used to be hard-coded separately in `src/lib/adminPassword.ts`, in
 * `scripts/admin-password.mjs` and in `AdminSecurityPanel.tsx`. Lowering it
 * therefore required three edits, and missing the CLI would have left it
 * rejecting passwords the web UI and API happily accepted — a difference that
 * only shows up when an operator is already locked out.
 */

const ROOT = process.cwd();
const HOST = 'http://localhost:8410';
const CURRENT = 'correct horse battery staple';

const ENV_KEYS = [
  'ADMIN_PASSWORD_HASH',
  'ADMIN_PASSWORD_HASH_FILE',
  'ADMIN_PASSWORD_FILE',
  'ADMIN_TOTP_SECRET',
  'ADMIN_AUDIT_LOG',
  'ADMIN_ALLOW_INSECURE_HTTP',
  'ADMIN_COOKIE_SECURE',
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

function authHeaders(cookie = ''): Record<string, string> {
  return {
    'content-type': 'application/json',
    origin: HOST,
    'x-admin-request': '1',
    ...(cookie ? { cookie } : {})
  };
}

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

test('password policy — the floor is 8 characters and enforced by the server validator', () => {
  assert.strictEqual(MIN_ADMIN_PASSWORD_LENGTH, 8);
  assert.strictEqual(MAX_ADMIN_PASSWORD_LENGTH, 256);

  assert.strictEqual(validateAdminPassword('1234567').ok, false, '7 chars must be rejected');
  assert.strictEqual(validateAdminPassword('12345678').ok, true, '8 chars must be accepted');
  assert.strictEqual(validateAdminPassword('a'.repeat(256)).ok, true);
  assert.strictEqual(validateAdminPassword('a'.repeat(257)).ok, false);
  assert.strictEqual(validateAdminPassword('').ok, false);
  assert.strictEqual(validateAdminPassword(undefined).ok, false);
  assert.strictEqual(validateAdminPassword('has\u0000nul').ok, false);
});

test('password policy — the CLI uses the same floor as the server', async () => {
  const cli = read('scripts/admin-password.mjs');

  // The CLI cannot import the TypeScript module; assert its literal agrees.
  const match = cli.match(/const MIN_PASSWORD_LENGTH = (\d+);/);
  assert.ok(match, 'the CLI must declare MIN_PASSWORD_LENGTH');
  assert.strictEqual(
    Number(match[1]),
    MIN_ADMIN_PASSWORD_LENGTH,
    'the CLI floor must match the server floor'
  );

  const maxMatch = cli.match(/const MAX_PASSWORD_LENGTH = (\d+);/);
  assert.ok(maxMatch, 'the CLI must declare MAX_PASSWORD_LENGTH');
  assert.strictEqual(Number(maxMatch[1]), MAX_ADMIN_PASSWORD_LENGTH);
});

test('password policy — the UI reads the shared constant instead of a literal', () => {
  const panel = read('src/components/AdminSecurityPanel.tsx');

  assert.match(
    panel,
    /from '@\/lib\/passwordPolicy'/,
    'the panel must import the shared bounds'
  );
  assert.match(panel, /MIN_ADMIN_PASSWORD_LENGTH/, 'the pre-check must use the constant');
  assert.match(panel, /新密碼（至少 \{MIN_ADMIN_PASSWORD_LENGTH\} 字元）/, 'the hint must be derived');
  assert.doesNotMatch(panel, /至少 12 字元/, 'a stale hard-coded hint must not survive');
  assert.doesNotMatch(panel, /newPassword\.length < 12/, 'a stale hard-coded pre-check must not survive');
  assert.doesNotMatch(panel, /maxLength=\{256\}/, 'the input bound must use the constant');
});

test('password policy — the browser-safe module pulls in no node built-ins', () => {
  const policy = read('src/lib/passwordPolicy.ts');

  // If this module ever imports fs/crypto the client bundle breaks, so the
  // constant would have to be duplicated again.
  assert.doesNotMatch(policy, /from 'node:|require\(|from 'fs'|from 'crypto'|from 'path'/);
  assert.match(policy, /export const MIN_ADMIN_PASSWORD_LENGTH = 8;/);
});

test('password policy — the README documents the enforced floor', () => {
  const readme = read('README.md');
  assert.match(readme, /至少 8 個字元/);
  assert.doesNotMatch(readme, /至少 12 個字元/);
});

test('password policy — the change-password endpoint enforces the floor', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui2-policy-endpoint-'));
  const file = path.join(dir, 'admin.json');
  writeAdminCredentialFile(file, { passwordHash: createScryptHash(CURRENT, { N: 1 << 14 }) });
  configure(file);
  t.after(() => {
    restoreEnv();
    resetAdminSessionsForTests();
    resetAdminLoginRateLimitForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const loginResponse = await login(
    new Request(`${HOST}/api/admin/login`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ password: CURRENT })
    })
  );
  assert.strictEqual(loginResponse.status, 200, await loginResponse.clone().text());
  const cookie = (loginResponse.headers.get('set-cookie') || '').split(';')[0] || '';

  const change = (newPassword: string) =>
    changePassword(
      new Request(`${HOST}/api/admin/password`, {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ currentPassword: CURRENT, newPassword })
      })
    );

  await t.test('a 7-character new password is refused with the policy code', async () => {
    const response = await change('1234567');
    assert.strictEqual(response.status, 400);
    const body = await response.json();
    assert.strictEqual(body.code, 'ADMIN_PASSWORD_POLICY');
    assert.match(body.error, /at least 8 characters/);
  });

  await t.test('an 8-character new password is accepted', async () => {
    const response = await change('12345678');
    assert.strictEqual(response.status, 200, await response.clone().text());
    const credential = readAdminCredential();
    assert.strictEqual(credential.ok, true);
    if (!credential.ok) return;
    assert.strictEqual(
      (await verifyPasswordAgainstHash('12345678', credential.hash)).ok,
      true
    );
  });
});
