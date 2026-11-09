import fs from 'fs';
import path from 'path';
import { appendAdminAudit } from './adminAudit';
import {
  acquireScanLock,
  appendLog,
  ensureLogDir,
  runTaskScript,
  type RunResult
} from './serverTasks';

/**
 * Daily automatic maintenance.
 *
 * The admin panel has two buttons — 「掃描/同步」(POST /api/scan → scan_fayun.py)
 * and 「巡檢/修復」(POST /api/health-check → auto_heal_catalog.py). Both used to
 * run only when someone pressed them. This module runs the same two scripts,
 * one after the other, once per day from inside the Next.js server process.
 *
 * Why in-process rather than host cron or a sidecar: the app ships as a single
 * container with no cron daemon, and the buttons' safety machinery (the
 * `scan.lock` single-writer lock, its heartbeat, `last-run.json`, scanner.log)
 * lives in this process. Reusing `acquireScanLock` + `runTaskScript` means a
 * scheduled run and a button press can never overlap: whichever comes second
 * sees the lock. The manual buttons are untouched.
 *
 * Duplicate protection:
 *  - `daily-maintenance.json` records the calendar date (in the configured time
 *    zone) the last daily run was claimed for; a restart the same day does not
 *    run it again.
 *  - An in-process flag stops a second tick from starting while one is running.
 *  - The scan lock stops it from running on top of a manual task; the scheduler
 *    waits for the lock instead of skipping.
 *
 * Configuration (all optional):
 *  - DAILY_MAINTENANCE=0       disable the schedule (buttons keep working)
 *  - DAILY_MAINTENANCE_TIME    "HH:MM", default 04:00
 *  - DAILY_MAINTENANCE_TZ      IANA zone, default Asia/Taipei
 */

export interface DailyConfig {
  enabled: boolean;
  hour: number;
  minute: number;
  timeZone: string;
}

export interface DailyTaskResult {
  task: string;
  runId: string | null;
  ok: boolean;
  code: number | null;
  startedAt: string | null;
  finishedAt: string;
  /** Present when the task never started (lock busy too long, disk unwritable). */
  skipped?: string;
}

export interface DailyState {
  /** Calendar date (YYYY-MM-DD in the configured zone) this run was claimed for. */
  date: string;
  status: 'running' | 'ok' | 'failed';
  startedAt: string;
  finishedAt?: string;
  results: DailyTaskResult[];
}

interface DailyTask {
  name: string;
  script: string;
  label: string;
  banner: string;
}

/** Same order an operator would use: pull new content first, then repair. */
export const DAILY_TASKS: readonly DailyTask[] = [
  {
    name: 'scan',
    script: 'scan_fayun.py',
    label: 'Scan',
    banner: '🔄 === [每日排程] 已觸發：連線 fayun.org 執行媒體同步與掃描 ==='
  },
  {
    name: 'heal',
    script: 'auto_heal_catalog.py',
    label: 'AutoHeal',
    banner: '🚑 === [每日排程] 已觸發：全站自我巡檢與目錄自動修復 ==='
  }
];

const DEFAULT_TIME = '04:00';
const DEFAULT_TZ = 'Asia/Taipei';
const TICK_MS = 60_000;
/** First check after boot is delayed so startup work is not competing with it. */
const FIRST_TICK_MS = 2 * 60_000;
/** How long a task waits for a manual run to release the lock before giving up. */
const LOCK_WAIT_MS = 2 * 60 * 60_000;
const LOCK_RETRY_MS = 60_000;

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function readDailyConfig(env: Record<string, string | undefined> = process.env): DailyConfig {
  const flag = (env.DAILY_MAINTENANCE || '').trim().toLowerCase();
  const enabled = !['0', 'false', 'off', 'no', 'disabled'].includes(flag);

  let hour = 4;
  let minute = 0;
  const raw = (env.DAILY_MAINTENANCE_TIME || DEFAULT_TIME).trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (m && Number(m[1]) < 24 && Number(m[2]) < 60) {
    hour = Number(m[1]);
    minute = Number(m[2]);
  } else if (env.DAILY_MAINTENANCE_TIME) {
    console.warn(`[Daily] Invalid DAILY_MAINTENANCE_TIME "${raw}"; using ${DEFAULT_TIME}.`);
  }

  let timeZone = (env.DAILY_MAINTENANCE_TZ || DEFAULT_TZ).trim();
  if (!isValidTimeZone(timeZone)) {
    console.warn(`[Daily] Invalid DAILY_MAINTENANCE_TZ "${timeZone}"; using ${DEFAULT_TZ}.`);
    timeZone = DEFAULT_TZ;
  }

  return { enabled, hour, minute, timeZone };
}

/** Wall-clock date and minute-of-day of `date` in `timeZone`. */
export function zonedParts(date: Date, timeZone: string): { dateKey: string; minuteOfDay: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || '00';
  return {
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
    minuteOfDay: Number(get('hour')) * 60 + Number(get('minute'))
  };
}

/**
 * Whether today's run is due: the scheduled time has passed today and today has
 * not been claimed yet. Being ">=" rather than "==" means a server that was down
 * at the scheduled minute catches up once when it comes back the same day.
 */
export function isDue(now: Date, config: DailyConfig, state: DailyState | null): boolean {
  if (!config.enabled) return false;
  const { dateKey, minuteOfDay } = zonedParts(now, config.timeZone);
  if (minuteOfDay < config.hour * 60 + config.minute) return false;
  return !state || state.date !== dateKey;
}

export function describeSchedule(config: DailyConfig = readDailyConfig()): string {
  if (!config.enabled) return '手動觸發（每日自動排程已停用）';
  const hh = String(config.hour).padStart(2, '0');
  const mm = String(config.minute).padStart(2, '0');
  return `每日 ${hh}:${mm}（${config.timeZone}）自動執行，亦可手動觸發`;
}

function statePath(): string {
  return path.join(ensureLogDir(), 'daily-maintenance.json');
}

export function readDailyState(): DailyState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf-8')) as Partial<DailyState>;
    if (typeof parsed?.date !== 'string' || typeof parsed?.startedAt !== 'string') return null;
    return {
      date: parsed.date,
      status: parsed.status === 'ok' || parsed.status === 'failed' ? parsed.status : 'running',
      startedAt: parsed.startedAt,
      finishedAt: typeof parsed.finishedAt === 'string' ? parsed.finishedAt : undefined,
      results: Array.isArray(parsed.results) ? parsed.results : []
    };
  } catch {
    return null;
  }
}

function writeDailyState(state: DailyState): void {
  try {
    const target = statePath();
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmp, target);
  } catch (e) {
    console.warn('[Daily] Failed to record daily maintenance state:', e);
  }
}

/** Starts a script under an already-held lock and resolves when it exits. */
export type ScriptRunner = (task: DailyTask, token: string, runId: string) => Promise<RunResult>;

const defaultRunner: ScriptRunner = (task, token, runId) =>
  new Promise<RunResult>((resolve) => {
    runTaskScript(task.script, task.label, token, runId, resolve);
  });

export interface RunOptions {
  now?: Date;
  runner?: ScriptRunner;
  sleep?: (ms: number) => Promise<void>;
  lockWaitMs?: number;
  lockRetryMs?: number;
}

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

function newRunId(task: string): string {
  return `daily-${task}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function runOne(task: DailyTask, opts: Required<Omit<RunOptions, 'now'>>): Promise<DailyTaskResult> {
  const deadline = Date.now() + opts.lockWaitMs;
  let waitedLogged = false;

  for (;;) {
    const lock = acquireScanLock();
    if (lock.ok) {
      const startedAt = new Date().toISOString();
      const runId = newRunId(task.name);
      appendAdminAudit('admin_action', { action: task.name, via: 'scheduler', result: 'authorized' });
      appendLog(task.banner);
      console.log(`[Daily] Starting ${task.script} (runId=${runId}).`);
      const result = await opts.runner(task, lock.token, runId);
      return {
        task: task.name,
        runId,
        ok: result.ok,
        code: result.code,
        startedAt,
        finishedAt: result.finishedAt || new Date().toISOString()
      };
    }

    if (lock.reason === 'unavailable') {
      return {
        task: task.name,
        runId: null,
        ok: false,
        code: null,
        startedAt: null,
        finishedAt: new Date().toISOString(),
        skipped: `無法寫入任務鎖定檔：${lock.error}`
      };
    }

    // A manual run (or a leftover scheduled one) holds the lock: wait for it
    // rather than skipping the day or running on top of it.
    if (Date.now() >= deadline) {
      return {
        task: task.name,
        runId: null,
        ok: false,
        code: null,
        startedAt: null,
        finishedAt: new Date().toISOString(),
        skipped: '等待其他維護任務釋放鎖定逾時'
      };
    }
    if (!waitedLogged) {
      appendLog(`⏳ [每日排程] 已有掃描或修復任務執行中，等待完成後再執行「${task.name}」…`);
      waitedLogged = true;
    }
    await opts.sleep(opts.lockRetryMs);
  }
}

let inFlight = false;

/** True while a daily run is in progress in this process. */
export function isDailyRunInFlight(): boolean {
  return inFlight;
}

/**
 * Runs scan then heal once, recording the outcome. Returns null when another
 * daily run is already in progress in this process.
 */
export async function runDailyMaintenance(
  config: DailyConfig = readDailyConfig(),
  options: RunOptions = {}
): Promise<DailyState | null> {
  if (inFlight) return null;
  inFlight = true;
  try {
    const now = options.now || new Date();
    const opts = {
      runner: options.runner || defaultRunner,
      sleep: options.sleep || realSleep,
      lockWaitMs: options.lockWaitMs ?? LOCK_WAIT_MS,
      lockRetryMs: options.lockRetryMs ?? LOCK_RETRY_MS
    };

    // Claim the day BEFORE doing any work, so a restart mid-run does not start
    // a second daily run on the same date.
    const state: DailyState = {
      date: zonedParts(now, config.timeZone).dateKey,
      status: 'running',
      startedAt: new Date().toISOString(),
      results: []
    };
    writeDailyState(state);
    appendLog(`⏰ === 每日自動維護開始（${state.date}）：掃描同步 → 巡檢修復 ===`);

    for (const task of DAILY_TASKS) {
      let result: DailyTaskResult;
      try {
        result = await runOne(task, opts);
      } catch (e) {
        result = {
          task: task.name,
          runId: null,
          ok: false,
          code: null,
          startedAt: null,
          finishedAt: new Date().toISOString(),
          skipped: `排程錯誤：${(e as Error)?.message || String(e)}`
        };
      }
      state.results.push(result);
      writeDailyState(state);
    }

    state.status = state.results.every((r) => r.ok) ? 'ok' : 'failed';
    state.finishedAt = new Date().toISOString();
    writeDailyState(state);

    const summary = state.results
      .map((r) => `${r.task} ${r.ok ? '✅' : '❌'}${r.skipped ? `（${r.skipped}）` : r.ok ? '' : `（code=${r.code}）`}`)
      .join('、');
    appendLog(`⏰ === 每日自動維護結束（${state.date}）：${summary} ===`);
    console.log(`[Daily] Finished ${state.date}: ${state.status} — ${summary}`);
    appendAdminAudit('scheduled_maintenance', {
      date: state.date,
      result: state.status,
      scan: state.results[0]?.ok ? 'ok' : 'failed',
      heal: state.results[1]?.ok ? 'ok' : 'failed'
    });
    return state;
  } finally {
    inFlight = false;
  }
}

type SchedulerGlobal = typeof globalThis & { __ui2DailyMaintenanceTimer?: NodeJS.Timeout };

/** Checks whether today's run is due and, if so, starts it. */
export function tick(config: DailyConfig = readDailyConfig(), now: Date = new Date()): boolean {
  if (inFlight) return false;
  if (!isDue(now, config, readDailyState())) return false;
  void runDailyMaintenance(config, { now }).catch((e: unknown) => {
    console.error('[Daily] Daily maintenance failed:', e);
  });
  return true;
}

/**
 * Starts the once-a-minute check. Idempotent: a second call (dev hot reload,
 * repeated register) does not create a second timer.
 */
export function startDailyMaintenance(config: DailyConfig = readDailyConfig()): void {
  const g = globalThis as SchedulerGlobal;
  if (!config.enabled) {
    console.log('[Daily] Daily automatic scan/repair is disabled (DAILY_MAINTENANCE=0).');
    return;
  }
  if (g.__ui2DailyMaintenanceTimer) return;

  const check = () => {
    try {
      tick(config);
    } catch (e) {
      console.error('[Daily] Scheduler tick failed:', e);
    }
  };

  const first = setTimeout(() => {
    check();
    const timer = setInterval(check, TICK_MS);
    timer.unref?.();
    g.__ui2DailyMaintenanceTimer = timer;
  }, FIRST_TICK_MS);
  first.unref?.();
  g.__ui2DailyMaintenanceTimer = first;

  console.log(`[Daily] Automatic scan + repair scheduled: ${describeSchedule(config)}.`);
}
