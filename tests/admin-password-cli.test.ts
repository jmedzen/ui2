import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { parseScryptHash, verifyPasswordAgainstHash } from '@/lib/adminPassword';

const SCRIPT = path.join(process.cwd(), 'scripts', 'admin-password.mjs');
const PASSWORD = 'a sufficiently long test password';

function run(args: string[], input?: string) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    input,
    encoding: 'utf-8',
    env: {
      ...process.env,
      ADMIN_PASSWORD_HASH: '',
      ADMIN_PASSWORD_HASH_FILE: '',
      ADMIN_TOTP_SECRET: ''
    }
  });
}

test('admin-password CLI — --hash prints a valid verifiable scrypt hash', async () => {
  const result = run(['--stdin', '--hash'], `${PASSWORD}\n`);
  assert.strictEqual(result.status, 0, result.stderr);
  const hash = result.stdout.trim();
  assert.strictEqual(parseScryptHash(hash).ok, true);
  assert.deepStrictEqual(await verifyPasswordAgainstHash(PASSWORD, hash), { ok: true });
});

test('admin-password CLI — writes an atomic 0600 JSON file and can check/delete it', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('the CLI intentionally refuses to write as root');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui2-admin-cli-'));
  const file = path.join(dir, 'admin.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = run(['--stdin', '--file', file], `${PASSWORD}\n`);
  assert.strictEqual(write.status, 0, write.stderr);

  const raw = fs.readFileSync(file, 'utf-8');
  assert.ok(!raw.includes(PASSWORD), 'the plaintext password must not be stored');
  const parsed = JSON.parse(raw);
  assert.strictEqual(parsed.version, 1);
  assert.strictEqual(parsed.algorithm, 'scrypt');
  assert.strictEqual(parseScryptHash(parsed.passwordHash).ok, true);

  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  }

  const check = run(['--check', '--file', file]);
  assert.strictEqual(check.status, 0, check.stderr);
  assert.match(check.stdout, /Credential is valid/);

  const remove = run(['--delete', '--file', file]);
  assert.strictEqual(remove.status, 0, remove.stderr);
  assert.strictEqual(fs.existsSync(file), false);
});

test('admin-password CLI — TOTP enrollment survives password changes and can be disabled', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('the CLI intentionally refuses to write as root');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui2-admin-cli-totp-'));
  const file = path.join(dir, 'admin.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = run(['--stdin', '--file', file], `${PASSWORD}\n`);
  assert.strictEqual(write.status, 0, write.stderr);

  const enable = run(['--enable-totp', '--file', file]);
  assert.strictEqual(enable.status, 0, enable.stderr);
  assert.match(enable.stdout, /TOTP enabled/);
  assert.match(enable.stdout, /otpauth:\/\/totp\//);

  const enabled = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.match(enabled.totpSecret, /^[A-Z2-7]+$/);
  assert.strictEqual(typeof enabled.totpUpdatedAt, 'string');

  const check = run(['--check', '--file', file]);
  assert.strictEqual(check.status, 0, check.stderr);
  assert.match(check.stdout, /TOTP 2FA: enabled/);

  const changed = run(['--stdin', '--file', file], 'a new sufficiently long password\n');
  assert.strictEqual(changed.status, 0, changed.stderr);
  const afterChange = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.strictEqual(afterChange.totpSecret, enabled.totpSecret, 'password change must preserve TOTP');

  const disable = run(['--disable-totp', '--file', file]);
  assert.strictEqual(disable.status, 0, disable.stderr);
  assert.match(disable.stdout, /TOTP disabled/);
  const afterDisable = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.strictEqual(afterDisable.totpSecret, undefined);
});
