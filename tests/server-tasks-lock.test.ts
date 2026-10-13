// Must come first: points the media cache and task log dir at throwaway paths.
import './helpers/isolated-media-cache';

import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  acquireScanLock,
  releaseScanLock,
  isScanLocked,
  getScanLockInfo,
  reclaimOrphanedLock,
  checkLogDirWritable
} from '@/lib/serverTasks';

const LOG_DIR = process.env.TASK_LOG_DIR as string;
const LOCK = path.join(LOG_DIR, 'scan.lock');

function reset() {
  try {
    fs.rmSync(LOCK, { force: true });
  } catch {}
}

/**
 * Writes a lock file exactly as a given producer would.
 *
 * A pid of 999999 is not a real process, which is how we simulate a lock left
 * behind by a server that has since exited.
 */
function writeLock(contents: string, ageMs = 0) {
  fs.writeFileSync(LOCK, contents);
  if (ageMs > 0) {
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(LOCK, t, t);
  }
}

test('scan lock — acquisition is exclusive', async (t) => {
  await t.test('a free lock is acquired and released', () => {
    reset();
    const first = acquireScanLock();
    assert.strictEqual(first.ok, true);
    assert.strictEqual(isScanLocked(), true);
    releaseScanLock();
    assert.strictEqual(isScanLocked(), false);
  });

  await t.test('a second acquisition reports busy, not a fabricated reason', () => {
    reset();
    assert.strictEqual(acquireScanLock().ok, true);

    const second = acquireScanLock();
    assert.strictEqual(second.ok, false);
    // The holder is this very process, so the lock is genuinely live.
    if (!second.ok && second.reason === 'busy') {
      assert.strictEqual(second.holder?.pid, process.pid);
    } else {
      assert.fail(`expected busy, got ${JSON.stringify(second)}`);
    }
    releaseScanLock();
  });
});

// Regression: the original lock was judged by mtime alone, so a lock file left
// behind by a restart blocked every trigger for 30 minutes even though nothing
// was running. This is the exact cause of the repeated
// "A scan or repair task is already running" the user hit.
test('scan lock — a lock from a dead process is reclaimed', async (t) => {
  await t.test('dead pid with a fresh mtime does not block', () => {
    reset();
    // Fresh (age 0) but owned by a pid that cannot exist.
    writeLock(JSON.stringify({ pid: 999999, hostname: os.hostname(), startedAt: new Date().toISOString() }));

    const result = acquireScanLock();
    assert.strictEqual(result.ok, true, 'a dead process must not hold the lock');
    releaseScanLock();
  });

  await t.test('legacy "<pid>@<iso>" format is understood', () => {
    reset();
    writeLock(`999999@${new Date().toISOString()}\n`);

    assert.strictEqual(isScanLocked(), false, 'dead pid must read as unlocked');
    assert.strictEqual(acquireScanLock().ok, true);
    releaseScanLock();
  });

  await t.test('the boot reclaim clears an orphan and reports it', () => {
    reset();
    writeLock(JSON.stringify({ pid: 999999, hostname: os.hostname(), startedAt: '2024-01-01T00:00:00.000Z' }), 60_000);

    const reclaimed = reclaimOrphanedLock();
    assert.ok(reclaimed, 'expected the orphaned lock to be reported');
    assert.strictEqual(reclaimed?.pid, 999999);
    assert.strictEqual(fs.existsSync(LOCK), false);
  });

  await t.test('an old lock is stale even if the pid looks alive', () => {
    reset();
    // Our own pid is definitely alive, so only the age can make this stale.
    writeLock(
      JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: '2024-01-01T00:00:00.000Z' }),
      31 * 60 * 1000
    );

    assert.strictEqual(isScanLocked(), false);
    assert.strictEqual(acquireScanLock().ok, true);
    releaseScanLock();
  });
});

// Regression: an unwritable data directory made writeFileSync throw EACCES,
// which the old code swallowed into `return false` and the route reported as
// "A scan or repair task is already running" — a permissions bug disguised as a
// concurrency conflict.
test('scan lock — an unwritable directory is reported as unavailable', async (t) => {
  const original = process.env.TASK_LOG_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fy-ro-'));
  try {
    await t.test('acquireScanLock distinguishes unavailable from busy', () => {
      // A path under a regular file can never be created: this reproduces the
      // EACCES/ENOTDIR class of failure without depending on running as root.
      const blocker = path.join(dir, 'blocker');
      fs.writeFileSync(blocker, 'not a directory');
      process.env.TASK_LOG_DIR = path.join(blocker, 'logs');

      const result = acquireScanLock();
      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.strictEqual(result.reason, 'unavailable', 'must not claim to be busy');
        assert.match(result.error, /ENOTDIR|EACCES|EEXIST|EPERM/);
      }
    });

    await t.test('checkLogDirWritable reports the failure', () => {
      const probe = checkLogDirWritable();
      assert.strictEqual(probe.writable, false);
      assert.ok(probe.error, 'expected an error detail');
    });
  } finally {
    process.env.TASK_LOG_DIR = original;
    reset();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scan lock — checkLogDirWritable succeeds on a usable directory', () => {
  reset();
  const probe = checkLogDirWritable();
  assert.strictEqual(probe.writable, true);
  // The probe must clean up after itself.
  assert.strictEqual(
    fs.readdirSync(LOG_DIR).some((f) => f.startsWith('.write-probe')),
    false
  );
});

test('scan lock — getScanLockInfo exposes the holder', async (t) => {
  await t.test('null when unlocked', () => {
    reset();
    assert.strictEqual(getScanLockInfo(), null);
  });

  await t.test('describes the live holder', () => {
    reset();
    acquireScanLock();
    const info = getScanLockInfo();
    assert.strictEqual(info?.pid, process.pid);
    assert.strictEqual(info?.hostname, os.hostname());
    assert.match(info?.age ?? '', /^\d+[hms]/);
    releaseScanLock();
  });
});

test('scan lock — a garbage lock file does not wedge the task queue', () => {
  reset();
  // Unparseable content: fall back to age, and a fresh one still blocks.
  writeLock('this is not a lock file');
  assert.strictEqual(acquireScanLock().ok, false, 'unparseable + fresh is treated as held');
  releaseScanLock();

  writeLock('this is not a lock file', 31 * 60 * 1000);
  assert.strictEqual(acquireScanLock().ok, true, 'unparseable + stale is reclaimed');
  releaseScanLock();
});
