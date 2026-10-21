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

/**
 * Running as root inside the container.
 *
 * The image has no `USER node` (the entrypoint needs root to align the
 * bind-mounted ./data volume), so `docker compose exec` opens a ROOT shell. The
 * CLI used to refuse outright, and its message told the operator to re-run from
 * the host with `-u node` — useless advice when they are already inside the
 * container. Root is now allowed, but it must hand the 0600 file to the account
 * the app actually runs as, otherwise every login fails with ADMIN_UNAVAILABLE.
 */
test('admin-password CLI — root resolution picks an account the app can read as', async () => {
  const { resolveCredentialOwner } = await import('../scripts/credential-owner.mjs');

  const alpine = [
    'root:x:0:0:root:/root:/bin/ash',
    'bin:x:1:1:bin:/bin:/sbin/nologin',
    'node:x:1000:1000:Linux User,,,:/home/node:/bin/sh'
  ].join('\n');

  assert.deepStrictEqual(resolveCredentialOwner({ env: {}, passwdText: alpine }), {
    uid: 1000,
    gid: 1000,
    name: 'node'
  });

  // Explicit overrides win, and a bare uid reuses it as the gid.
  assert.deepStrictEqual(
    resolveCredentialOwner({ env: { ADMIN_FILE_OWNER: '1000:1000' }, passwdText: alpine }),
    { uid: 1000, gid: 1000, name: '1000:1000' }
  );
  assert.deepStrictEqual(
    resolveCredentialOwner({ env: { ADMIN_FILE_OWNER: '1001' }, passwdText: alpine }),
    { uid: 1001, gid: 1001, name: '1001' }
  );
  assert.deepStrictEqual(
    resolveCredentialOwner({ env: { ADMIN_FILE_OWNER: 'node' }, passwdText: alpine }),
    { uid: 1000, gid: 1000, name: 'node' }
  );

  // No "node" account (a plain host or a differently-named image user): the
  // caller must warn rather than guess an owner.
  assert.strictEqual(
    resolveCredentialOwner({ env: {}, passwdText: 'root:x:0:0:root:/root:/bin/sh' }),
    null
  );
  // An override naming a missing account is also null, never a silent no-op.
  assert.strictEqual(
    resolveCredentialOwner({ env: { ADMIN_FILE_OWNER: 'nosuch' }, passwdText: alpine }),
    null
  );
});

test('admin-password CLI — writing as root is no longer refused outright', () => {
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  // The old guard aborted before writing anything when uid was 0.
  assert.doesNotMatch(
    src,
    /Refusing to write as root/,
    'root must be allowed so the file can be handed to the app account'
  );
  // It must still transfer ownership, not merely "allow root".
  assert.match(src, /function transferOwnership/, 'root writes must chown the file');
  assert.match(src, /resolveCredentialOwner\(/, 'the target account must be resolved');
  assert.match(
    src,
    /const ownership = transferOwnership\(temp, dir, createdDir\);\s*\n\s*fs\.renameSync\(temp, file\);/,
    'chown must happen before the atomic rename, so the file is never root-owned at its final path'
  );
});
