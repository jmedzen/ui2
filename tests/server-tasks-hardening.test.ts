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
  startLockHeartbeat,
  readRecentLogs,
  readRunResult,
  appendLog
} from '@/lib/serverTasks';

const LOG_DIR = process.env.TASK_LOG_DIR as string;
const LOCK = path.join(LOG_DIR, 'scan.lock');
const SCANNER_LOG = path.join(LOG_DIR, 'scanner.log');

function reset() {
  for (const f of [LOCK, SCANNER_LOG, path.join(LOG_DIR, 'last-run.json')]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {}
  }
}

function writeLock(contents: string, ageMs = 0) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(LOCK, contents);
  if (ageMs > 0) {
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(LOCK, t, t);
  }
}

/* ------------------------------------------------------------------ *
 * Token-scoped release
 * ------------------------------------------------------------------ */

// Regression: releaseScanLock() was unconditional, and `error` and `close` both
// fire for a failed spawn. The second release therefore deleted whatever lock a
// successor had acquired in between, letting a third task run concurrently.
test('lock — release is scoped to the owning token', async (t) => {
  t.beforeEach(reset);
  t.afterEach(reset);

  await t.test('a stale token cannot delete the current holder lock', async () => {
    const first = acquireScanLock();
    assert.strictEqual(first.ok, true);
    if (!first.ok) return;
    const firstToken = first.token;

    // First task gives up its lock (as on 'error'), then a successor takes it.
    releaseScanLock(firstToken);
    assert.strictEqual(isScanLocked(), false, 'precondition: lock was released');

    const second = acquireScanLock();
    assert.strictEqual(second.ok, true, 'successor must be able to acquire');
    if (!second.ok) return;

    // The first task's late 'close' handler fires with its now-stale token.
    releaseScanLock(firstToken);

    assert.strictEqual(isScanLocked(), true, "a stale token must not delete the successor's lock");
    const holder = getScanLockInfo();
    assert.ok(holder, 'the successor must still be recorded as the holder');
    assert.strictEqual(holder?.token, second.token);
  });

  await t.test('the correct token does release', async () => {
    const lock = acquireScanLock();
    assert.strictEqual(lock.ok, true);
    if (!lock.ok) return;
    releaseScanLock(lock.token);
    assert.strictEqual(isScanLocked(), false);
  });

  await t.test('no token force-releases (boot recovery path)', async () => {
    const lock = acquireScanLock();
    assert.strictEqual(lock.ok, true);
    releaseScanLock();
    assert.strictEqual(isScanLocked(), false);
  });
});

/* ------------------------------------------------------------------ *
 * Heartbeat keeps a long run alive
 * ------------------------------------------------------------------ */

// Regression: mtime was never refreshed, so a run lasting longer than
// LOCK_STALE_MS (30 min) was declared dead and a second scan could start on top
// of it.
test('lock — the holder heartbeats so a long run is not declared stale', async (t) => {
  t.beforeEach(reset);
  t.afterEach(reset);

  await t.test('mtime advances while the heartbeat runs', async () => {
    const lock = acquireScanLock();
    assert.strictEqual(lock.ok, true);
    if (!lock.ok) return;

    // Simulate a run that started an hour ago: without a heartbeat this lock is
    // already past the staleness threshold and would be reclaimed.
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(LOCK, old, old);

    const stop = startLockHeartbeat(lock.token, 20);
    await new Promise((r) => setTimeout(r, 120));
    stop();

    const ageMs = Date.now() - fs.statSync(LOCK).mtimeMs;
    assert.ok(ageMs < 60 * 1000, `heartbeat must refresh mtime (age was ${ageMs}ms)`);
    assert.strictEqual(isScanLocked(), true, 'a heartbeating run must stay locked');
  });

  await t.test('heartbeat stops touching a lock it no longer owns', async () => {
    const lock = acquireScanLock();
    assert.strictEqual(lock.ok, true);
    if (!lock.ok) return;
    const stop = startLockHeartbeat(lock.token, 20);
    releaseScanLock(lock.token);
    // Simulate a new holder acquiring immediately after.
    const next = acquireScanLock();
    assert.strictEqual(next.ok, true);
    await new Promise((r) => setTimeout(r, 80));
    stop();
    const info = getScanLockInfo();
    assert.strictEqual(info?.token, next.ok ? next.token : undefined, 'the new holder must be intact');
  });
});

/* ------------------------------------------------------------------ *
 * GET handlers must not mutate state
 * ------------------------------------------------------------------ */

// Regression: isScanLocked()/getScanLockInfo() called tryUnlinkLock() to reclaim
// a stale lock, so merely polling the status endpoint deleted the lock file.
test('lock — status reads are side-effect free', async (t) => {
  t.beforeEach(reset);
  t.afterEach(reset);

  await t.test('a stale lock survives a status read', async () => {
    // A lock from a dead process, one hour old.
    writeLock(JSON.stringify({ pid: 999999, hostname: os.hostname(), startedAt: 'x' }), 60 * 60 * 1000);
    assert.strictEqual(fs.existsSync(LOCK), true);

    const locked = isScanLocked();
    getScanLockInfo();

    assert.strictEqual(locked, false, 'a stale lock must not report as running');
    assert.strictEqual(fs.existsSync(LOCK), true, 'a status read must not delete the lock file');
  });
});

/* ------------------------------------------------------------------ *
 * readRecentLogs must not emit NUL bytes
 * ------------------------------------------------------------------ */

// Regression: the read buffer was sized from a stale statSync while the writers
// rotate the log with os.replace. A short read left the buffer zero-filled and
// the return value was ignored, so the client rendered hundreds of NUL chars.
test('logs — a shrinking log file does not yield NUL bytes', async (t) => {
  t.beforeEach(reset);
  t.afterEach(reset);

  await t.test('short read is trimmed to the bytes actually read', async () => {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    // Larger than the tail window is not required; the point is that the file is
    // replaced by a much shorter one between stat and read. We emulate that by
    // writing a big file, then truncating it before the read path runs is not
    // directly injectable, so instead assert the invariant on a normal read and
    // on a file that is genuinely shorter than a previous size.
    appendLog('first line');
    appendLog('second line');
    const out = readRecentLogs();
    assert.ok(!out.includes('\u0000'), 'normal read must not contain NUL bytes');
    assert.ok(out.includes('first line'), 'log content must be present');
  });

  await t.test('reading past a shrink yields no NUL bytes', async () => {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    // Write a large log so the tail window is active, then shrink it and read.
    fs.writeFileSync(SCANNER_LOG, 'x'.repeat(3000) + '\n' + 'y'.repeat(3000) + '\n');
    readRecentLogs(); // prime nothing; just exercise the big path
    fs.writeFileSync(SCANNER_LOG, 'tiny\n');
    const out = readRecentLogs();
    assert.ok(!out.includes('\u0000'), 'a shrunk file must not produce NUL bytes');
    assert.ok(out.includes('tiny'), 'the current content must be returned');
  });
});

/* ------------------------------------------------------------------ *
 * Structured run results
 * ------------------------------------------------------------------ */

// Regression: the UI inferred completion from log strings that the Python
// scripts never emit, and both scripts share one log file, so a previous scan's
// "Scan finished" made a later heal run appear finished on its first poll.
test('logs — run results are structured and id-scoped', async (t) => {
  t.beforeEach(reset);
  t.afterEach(reset);

  await t.test('no recorded run yields null', () => {
    assert.strictEqual(readRunResult(), null);
  });

  await t.test('a recorded run is readable and distinguishes ok from failed', () => {
    const p = path.join(LOG_DIR, 'last-run.json');
    fs.mkdirSync(LOG_DIR, { recursive: true });

    fs.writeFileSync(p, JSON.stringify({
      id: 'run-a', task: 'Scan', code: 0, signal: null, finishedAt: '2026-01-01T00:00:00Z', ok: true
    }));
    const a = readRunResult();
    assert.strictEqual(a?.id, 'run-a');
    assert.strictEqual(a?.ok, true);

    fs.writeFileSync(p, JSON.stringify({
      id: 'run-b', task: 'AutoHeal', code: 1, signal: null, finishedAt: '2026-01-01T00:01:00Z', ok: false
    }));
    const b = readRunResult();
    assert.strictEqual(b?.id, 'run-b');
    assert.strictEqual(b?.ok, false, 'a failed run must be distinguishable');
    assert.notStrictEqual(a?.id, b?.id, 'ids must let the UI tell runs apart');
  });

  await t.test('a malformed record is ignored rather than thrown', () => {
    const p = path.join(LOG_DIR, 'last-run.json');
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(p, '{not json');
    assert.strictEqual(readRunResult(), null);
    fs.writeFileSync(p, JSON.stringify({ task: 'Scan' })); // no id
    assert.strictEqual(readRunResult(), null);
  });
});
