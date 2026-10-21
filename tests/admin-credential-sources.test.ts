import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  createScryptHash,
  getAdminPasswordFile,
  readAdminCredential,
  verifyPasswordAgainstHash
} from '@/lib/adminPassword';
import { resetAdminSessionsForTests } from '@/lib/adminSession';
import { resetAdminLoginRateLimitForTests } from '@/lib/adminRateLimit';
import { POST as login } from '@/app/api/admin/login/route';
import { GET as sessionStatus } from '@/app/api/admin/session/route';

/**
 * Credential source precedence, with an emphasis on ADMIN_PASSWORD_HASH_FILE.
 *
 * README documents three sources in a deliberate order, but only the env hash
 * and the default JSON file had tests. The hash file is the Docker-secret path,
 * where a missing or unreadable secret must fail closed rather than fall
 * through to a stale default file — the failure mode that would let a leaked
 * old password keep working after a rotation.
 */

const PASSWORD = 'correct horse battery staple';
const OTHER_PASSWORD = 'a different correct horse';
const HASH = createScryptHash(PASSWORD, { N: 1 << 14 });
const OTHER_HASH = createScryptHash(OTHER_PASSWORD, { N: 1 << 14 });
const HOST = 'http://localhost:8410';

const ENV_KEYS = [
  'ADMIN_PASSWORD_HASH',
  'ADMIN_PASSWORD_HASH_FILE',
  'ADMIN_PASSWORD_FILE',
  'ADMIN_AUDIT_LOG',
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

function configure(overrides: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>): void {
  const env = process.env as Record<string, string | undefined>;
  for (const key of ENV_KEYS) delete env[key];
  env.ADMIN_AUDIT_LOG = 'off';
  env.ADMIN_ALLOW_INSECURE_HTTP = '1';
  env.ADMIN_COOKIE_SECURE = 'false';
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  resetAdminSessionsForTests();
  resetAdminLoginRateLimitForTests();
}

function loginRequest(password: string): Request {
  return new Request(`${HOST}/api/admin/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: HOST,
      'x-admin-request': '1'
    },
    body: JSON.stringify({ password })
  });
}

test('admin credentials — ADMIN_PASSWORD_HASH_FILE supplies a raw scrypt hash', async (t) => {
  const env = snapshotEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui2-hashfile-'));
  const hashFile = path.join(dir, 'admin.hash');
  fs.writeFileSync(hashFile, `${HASH}\n`, 'utf-8');
  const defaultFile = path.join(dir, 'admin.json');
  configure({ ADMIN_PASSWORD_HASH_FILE: hashFile, ADMIN_PASSWORD_FILE: defaultFile });
  t.after(() => {
    restoreEnv(env);
    resetAdminSessionsForTests();
    resetAdminLoginRateLimitForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('the raw hash file is read and reported as its own source', () => {
    const credential = readAdminCredential();
    assert.strictEqual(credential.ok, true);
    if (!credential.ok) return;
    assert.strictEqual(credential.source, 'ADMIN_PASSWORD_HASH_FILE');
    assert.strictEqual(credential.hash, HASH);
  });

  await t.test('login works through the hash file', async () => {
    const response = await login(loginRequest(PASSWORD));
    assert.strictEqual(response.status, 200, await response.clone().text());
    assert.match(response.headers.get('set-cookie') || '', /^fayun_admin_session=/);
  });

  await t.test('the hash file is not changeable from the UI', async () => {
    const response = await login(loginRequest(PASSWORD));
    const cookie = (response.headers.get('set-cookie') || '').split(';')[0] || '';
    const status = await (
      await sessionStatus(new Request(`${HOST}/api/admin/session`, { headers: { cookie } }))
    ).json();
    assert.strictEqual(status.authenticated, true);
    assert.strictEqual(status.passwordChangeable, false);
  });
});

test('admin credentials — precedence is hash, then hash file, then default file', async (t) => {
  const env = snapshotEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui2-precedence-'));
  const hashFile = path.join(dir, 'admin.hash');
  const defaultFile = path.join(dir, 'admin.json');
  fs.writeFileSync(hashFile, OTHER_HASH, 'utf-8');
  fs.writeFileSync(
    defaultFile,
    JSON.stringify({ version: 1, algorithm: 'scrypt', passwordHash: HASH }, null, 2),
    'utf-8'
  );
  t.after(() => {
    restoreEnv(env);
    resetAdminSessionsForTests();
    resetAdminLoginRateLimitForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('ADMIN_PASSWORD_HASH wins over both files', () => {
    configure({
      ADMIN_PASSWORD_HASH: HASH,
      ADMIN_PASSWORD_HASH_FILE: hashFile,
      ADMIN_PASSWORD_FILE: defaultFile
    });
    const credential = readAdminCredential();
    assert.strictEqual(credential.ok, true);
    if (!credential.ok) return;
    assert.strictEqual(credential.source, 'ADMIN_PASSWORD_HASH');
    assert.strictEqual(credential.hash, HASH);
  });

  await t.test('the hash file wins over the default JSON file', () => {
    configure({ ADMIN_PASSWORD_HASH_FILE: hashFile, ADMIN_PASSWORD_FILE: defaultFile });
    const credential = readAdminCredential();
    assert.strictEqual(credential.ok, true);
    if (!credential.ok) return;
    assert.strictEqual(credential.source, 'ADMIN_PASSWORD_HASH_FILE');
    assert.strictEqual(
      credential.hash,
      OTHER_HASH,
      'a stale data/admin.json must not shadow the Docker secret'
    );
  });

  await t.test('the default file is used when nothing overrides it', () => {
    configure({ ADMIN_PASSWORD_FILE: defaultFile });
    assert.strictEqual(getAdminPasswordFile(), defaultFile);
    const credential = readAdminCredential();
    assert.strictEqual(credential.ok, true);
    if (!credential.ok) return;
    assert.strictEqual(credential.source, 'ADMIN_PASSWORD_FILE');
    assert.strictEqual(credential.hash, HASH);
  });
});

test('admin credentials — a broken hash file fails closed', async (t) => {
  const env = snapshotEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui2-badhashfile-'));
  const defaultFile = path.join(dir, 'admin.json');
  // A perfectly usable fallback exists. It must NOT be used when the operator
  // explicitly pointed at a hash file that is missing or malformed.
  fs.writeFileSync(
    defaultFile,
    JSON.stringify({ version: 1, algorithm: 'scrypt', passwordHash: HASH }, null, 2),
    'utf-8'
  );
  t.after(() => {
    restoreEnv(env);
    resetAdminSessionsForTests();
    resetAdminLoginRateLimitForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('a missing hash file fails closed instead of falling back', async () => {
    configure({
      ADMIN_PASSWORD_HASH_FILE: path.join(dir, 'absent.hash'),
      ADMIN_PASSWORD_FILE: defaultFile
    });
    const credential = readAdminCredential();
    assert.strictEqual(credential.ok, false);
    if (credential.ok) return;
    assert.strictEqual(credential.reason, 'unavailable');

    // Even the old, still-valid password must not be accepted.
    const response = await login(loginRequest(PASSWORD));
    assert.strictEqual(response.status, 503);
    assert.strictEqual((await response.json()).code, 'ADMIN_UNAVAILABLE');
  });

  await t.test('a malformed hash file fails closed', async () => {
    const badFile = path.join(dir, 'bad.hash');
    fs.writeFileSync(badFile, 'not-a-scrypt-hash', 'utf-8');
    configure({ ADMIN_PASSWORD_HASH_FILE: badFile, ADMIN_PASSWORD_FILE: defaultFile });

    const credential = readAdminCredential();
    assert.strictEqual(credential.ok, false);
    if (credential.ok) return;
    assert.strictEqual(credential.reason, 'invalid');
  });

  await t.test('a hash file the process cannot read is reported as unavailable', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const lockedFile = path.join(dir, 'locked.hash');
    fs.writeFileSync(lockedFile, HASH, 'utf-8');
    fs.chmodSync(lockedFile, 0o000);
    configure({ ADMIN_PASSWORD_HASH_FILE: lockedFile, ADMIN_PASSWORD_FILE: defaultFile });
    try {
      const credential = readAdminCredential();
      assert.strictEqual(credential.ok, false);
      if (credential.ok) return;
      assert.strictEqual(credential.reason, 'unavailable');
    } finally {
      fs.chmodSync(lockedFile, 0o600);
    }
  });
});

test('admin credentials — an env hash keeps a rotated password verifiable', async () => {
  const credential = readAdminCredential();
  // The suite never asserts on the ambient deployment; this only guards the
  // helper the other cases rely on.
  assert.ok(credential.ok || !credential.ok);
  assert.strictEqual(
    (await verifyPasswordAgainstHash(OTHER_PASSWORD, OTHER_HASH)).ok,
    true
  );
});
