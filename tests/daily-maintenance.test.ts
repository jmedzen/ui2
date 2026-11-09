// Must come first: points the media cache and task log dir at throwaway paths.
import './helpers/isolated-media-cache';

import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import {
  readDailyConfig,
  zonedParts,
  isDue,
  readDailyState,
  runDailyMaintenance,
  tick,
  describeSchedule,
  DAILY_TASKS,
  type DailyConfig,
  type ScriptRunner
} from '@/lib/dailyMaintenance';
import { acquireScanLock, releaseScanLock, isScanLocked, readRunResult } from '@/lib/serverTasks';

// Keep the scheduler's audit lines out of the repository's data/logs.
process.env.ADMIN_AUDIT_LOG = 'off';

const LOG_DIR = process.env.TASK_LOG_DIR as string;
const STATE = path.join(LOG_DIR, 'daily-maintenance.json');
const LOCK = path.join(LOG_DIR, 'scan.lock');
const LOG = path.join(LOG_DIR, 'scanner.log');

const CONFIG: DailyConfig = { enabled: true, hour: 4, minute: 0, timeZone: 'Asia/Taipei' };

function reset() {
  for (const f of [STATE, LOCK, LOG]) fs.rmSync(f, { force: true });
}

/** A runner that records what ran and asserts the lock is held while it runs. */
function fakeRunner(outcomes: Record<string, boolean>, seen: string[]): ScriptRunner {
  return async (task, token, runId) => {
    assert.strictEqual(isScanLocked(), true, `${task.name} must run under the scan lock`);
    seen.push(task.name);
    releaseScanLock(token);
    const ok = outcomes[task.name] !== false;
    return { id: runId, task: task.label, code: ok ? 0 : 1, signal: null, finishedAt: new Date().toISOString(), ok };
  };
}

test('daily maintenance — configuration', async (t) => {
  await t.test('enabled by default at 04:00 Asia/Taipei', () => {
    assert.deepStrictEqual(readDailyConfig({}), CONFIG);
  });

  await t.test('can be disabled and retimed', () => {
    const c = readDailyConfig({ DAILY_MAINTENANCE: '0', DAILY_MAINTENANCE_TIME: '23:15', DAILY_MAINTENANCE_TZ: 'UTC' });
    assert.deepStrictEqual(c, { enabled: false, hour: 23, minute: 15, timeZone: 'UTC' });
    assert.match(describeSchedule(c), /停用/);
  });

  await t.test('invalid values fall back to defaults', () => {
    const c = readDailyConfig({ DAILY_MAINTENANCE_TIME: '25:99', DAILY_MAINTENANCE_TZ: 'Mars/Base' });
    assert.deepStrictEqual(c, CONFIG);
  });

  await t.test('runs scan before heal, the same scripts as the buttons', () => {
    assert.deepStrictEqual(DAILY_TASKS.map((x) => x.script), ['scan_fayun.py', 'auto_heal_catalog.py']);
  });
});

test('daily maintenance — due calculation uses the configured zone', async (t) => {
  // 2026-11-09T19:30Z is 2026-11-10 03:30 in Taipei; 20:00Z is 04:00.
  await t.test('zoned date and minute', () => {
    assert.deepStrictEqual(zonedParts(new Date('2026-11-09T19:30:00Z'), 'Asia/Taipei'), {
      dateKey: '2026-11-10',
      minuteOfDay: 3 * 60 + 30
    });
  });

  await t.test('not due before the scheduled time', () => {
    assert.strictEqual(isDue(new Date('2026-11-09T19:59:00Z'), CONFIG, null), false);
  });

  await t.test('due at or after the scheduled time when today is unclaimed', () => {
    assert.strictEqual(isDue(new Date('2026-11-09T20:00:00Z'), CONFIG, null), true);
    const yesterday = { date: '2026-11-09', status: 'ok' as const, startedAt: '', results: [] };
    assert.strictEqual(isDue(new Date('2026-11-10T09:00:00Z'), CONFIG, yesterday), true);
  });

  await t.test('not due again once today is claimed, even if it is still running', () => {
    const today = { date: '2026-11-10', status: 'running' as const, startedAt: '', results: [] };
    assert.strictEqual(isDue(new Date('2026-11-10T09:00:00Z'), CONFIG, today), false);
  });

  await t.test('never due when disabled', () => {
    assert.strictEqual(isDue(new Date('2026-11-10T09:00:00Z'), { ...CONFIG, enabled: false }, null), false);
  });
});

test('daily maintenance — run', async (t) => {
  await t.test('runs scan then heal under the lock and records the result', async () => {
    reset();
    const seen: string[] = [];
    const state = await runDailyMaintenance(CONFIG, {
      now: new Date('2026-11-09T20:05:00Z'),
      runner: fakeRunner({}, seen)
    });
    assert.deepStrictEqual(seen, ['scan', 'heal']);
    assert.strictEqual(state?.status, 'ok');
    assert.strictEqual(state?.date, '2026-11-10');
    assert.strictEqual(isScanLocked(), false);

    const saved = readDailyState();
    assert.strictEqual(saved?.status, 'ok');
    assert.deepStrictEqual(saved?.results.map((r) => [r.task, r.ok]), [['scan', true], ['heal', true]]);

    const log = fs.readFileSync(LOG, 'utf-8');
    assert.match(log, /每日自動維護開始（2026-11-10）/);
    assert.match(log, /每日自動維護結束（2026-11-10）：scan ✅、heal ✅/);
  });

  await t.test('a failed scan still runs heal and marks the day failed', async () => {
    reset();
    const seen: string[] = [];
    const state = await runDailyMaintenance(CONFIG, { runner: fakeRunner({ scan: false }, seen) });
    assert.deepStrictEqual(seen, ['scan', 'heal']);
    assert.strictEqual(state?.status, 'failed');
    assert.match(fs.readFileSync(LOG, 'utf-8'), /scan ❌（code=1）、heal ✅/);
  });

  await t.test('waits for a manual task holding the lock instead of overlapping it', async () => {
    reset();
    const manual = acquireScanLock();
    assert.ok(manual.ok);
    const seen: string[] = [];
    let sleeps = 0;
    const state = await runDailyMaintenance(CONFIG, {
      runner: fakeRunner({}, seen),
      lockWaitMs: 60_000,
      lockRetryMs: 1,
      sleep: async () => {
        sleeps++;
        // The manual run finishes after two retries.
        if (sleeps === 2 && manual.ok) releaseScanLock(manual.token);
      }
    });
    assert.strictEqual(sleeps, 2);
    assert.deepStrictEqual(seen, ['scan', 'heal']);
    assert.strictEqual(state?.status, 'ok');
    assert.match(fs.readFileSync(LOG, 'utf-8'), /等待完成後再執行/);
  });

  await t.test('gives up after the wait budget and records the skip', async () => {
    reset();
    const manual = acquireScanLock();
    assert.ok(manual.ok);
    const seen: string[] = [];
    const state = await runDailyMaintenance(CONFIG, {
      runner: fakeRunner({}, seen),
      lockWaitMs: 0,
      sleep: async () => {}
    });
    assert.deepStrictEqual(seen, []);
    assert.strictEqual(state?.status, 'failed');
    assert.ok(state?.results.every((r) => r.skipped));
    if (manual.ok) releaseScanLock(manual.token);
  });

  await t.test('a concurrent call in the same process does not start a second run', async () => {
    reset();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runner: ScriptRunner = async (task, token, runId) => {
      await gate;
      releaseScanLock(token);
      return { id: runId, task: task.label, code: 0, signal: null, finishedAt: '', ok: true };
    };
    const first = runDailyMaintenance(CONFIG, { runner });
    assert.strictEqual(await runDailyMaintenance(CONFIG, { runner }), null);
    // tick() must not start another one either while the first is running.
    assert.strictEqual(tick(CONFIG, new Date('2026-11-12T09:00:00Z')), false);
    release();
    assert.strictEqual((await first)?.status, 'ok');
  });

  await t.test('tick does not rerun a day already claimed (e.g. after a restart)', () => {
    reset();
    fs.writeFileSync(STATE, JSON.stringify({ date: '2026-11-10', status: 'running', startedAt: 'x', results: [] }));
    assert.strictEqual(tick(CONFIG, new Date('2026-11-10T09:00:00Z')), false);
  });
});

test('runTaskScript reports completion to its caller after releasing the lock', async () => {
  reset();
  const { runTaskScript } = await import('@/lib/serverTasks');
  const lock = acquireScanLock();
  assert.ok(lock.ok);
  const result = await new Promise<{ ok: boolean; lockedAtExit: boolean }>((resolve) => {
    if (!lock.ok) return;
    runTaskScript('does_not_exist.py', 'Missing', lock.token, 'rid-1', (r) =>
      resolve({ ok: r.ok, lockedAtExit: isScanLocked() })
    );
  });
  assert.deepStrictEqual(result, { ok: false, lockedAtExit: false });
  assert.strictEqual(readRunResult()?.id, 'rid-1');
});
