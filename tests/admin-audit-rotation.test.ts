import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { appendAdminAudit } from '@/lib/adminAudit';

const ENV_KEYS = [
  'ADMIN_AUDIT_LOG',
  'ADMIN_AUDIT_MAX_BYTES',
  'ADMIN_AUDIT_MAX_FILES'
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

test('admin audit — size rotation keeps multiple numbered generations', (t) => {
  const env = snapshotEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui2-audit-rotation-'));
  const logPath = path.join(dir, 'admin.log');
  process.env.ADMIN_AUDIT_LOG = logPath;
  // Every event is larger than one byte, so this rotates before each append.
  process.env.ADMIN_AUDIT_MAX_BYTES = '1';
  process.env.ADMIN_AUDIT_MAX_FILES = '3';

  t.after(() => {
    restoreEnv(env);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  for (let i = 1; i <= 5; i += 1) {
    appendAdminAudit(`rotation_event_${i}`, { index: i });
  }

  // Five writes with a three-file retention window leave the current file and
  // three backups; event 1 has aged out, and the newest event is current.
  assert.strictEqual(fs.existsSync(`${logPath}.4`), false);
  const current = fs.readFileSync(logPath, 'utf8');
  const one = fs.readFileSync(`${logPath}.1`, 'utf8');
  const two = fs.readFileSync(`${logPath}.2`, 'utf8');
  const three = fs.readFileSync(`${logPath}.3`, 'utf8');

  assert.match(current, /rotation_event_5/);
  assert.match(one, /rotation_event_4/);
  assert.match(two, /rotation_event_3/);
  assert.match(three, /rotation_event_2/);
  assert.ok(!current.includes('rotation_event_1'));
  assert.ok(!three.includes('rotation_event_1'));

  if (process.platform !== 'win32') {
    for (const file of [logPath, `${logPath}.1`, `${logPath}.2`, `${logPath}.3`]) {
      assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, `${file} mode`);
    }
  }
});

test('admin audit — max-files=1 still rotates without losing the current event', (t) => {
  const env = snapshotEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui2-audit-single-'));
  const logPath = path.join(dir, 'admin.log');
  process.env.ADMIN_AUDIT_LOG = logPath;
  process.env.ADMIN_AUDIT_MAX_BYTES = '1';
  process.env.ADMIN_AUDIT_MAX_FILES = '1';

  t.after(() => {
    restoreEnv(env);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  appendAdminAudit('single_one');
  appendAdminAudit('single_two');
  appendAdminAudit('single_three');

  assert.match(fs.readFileSync(logPath, 'utf8'), /single_three/);
  assert.match(fs.readFileSync(`${logPath}.1`, 'utf8'), /single_two/);
  assert.strictEqual(fs.existsSync(`${logPath}.2`), false);
});
