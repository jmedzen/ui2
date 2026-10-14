import { spawn, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** Name reported in logs/UI for the scanner task. */
export const SCAN_TASK = 'scan';
export const HEAL_TASK = 'heal';

const DEFAULT_LOG_DIR = path.join(/*turbopackIgnore: true*/ process.cwd(), 'data', 'logs');

/**
 * Resolved lazily so tests can redirect it.
 *
 * This used to be a module-level constant baked at import time, which forced
 * every test suite to write its lock and log into the *real* `data/logs`. That
 * made it possible for a test to plant a lock the running dev server then
 * honoured. TASK_LOG_DIR now lets the harness point somewhere disposable.
 */
function logDir(): string {
  return process.env.TASK_LOG_DIR || DEFAULT_LOG_DIR;
}

function scannerLogPath(): string {
  return path.join(logDir(), 'scanner.log');
}

function lockFilePath(): string {
  return path.join(logDir(), 'scan.lock');
}

/** Where the outcome of the most recent run is recorded. */
function runResultPath(): string {
  return path.join(logDir(), 'last-run.json');
}

/** Structured outcome of the most recent maintenance run. */
export interface RunResult {
  id: string;
  task: string;
  code: number | null;
  signal: string | null;
  finishedAt: string;
  ok: boolean;
}

/** Maximum number of trailing log lines returned to the client. */
const LOG_TAIL_LINES = 500;
/** Hard cap on how much of the log file we are willing to read per request. */
const LOG_READ_MAX_BYTES = 2 * 1024 * 1024;
/** A lock older than this is considered abandoned (crashed process). */
const LOCK_STALE_MS = 30 * 60 * 1000;

export function ensureLogDir(): string {
  const dir = logDir();
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
  }
  return dir;
}

export function getScannerLogPath(): string {
  ensureLogDir();
  return scannerLogPath();
}

/**
 * Records the outcome of a finished run.
 *
 * The UI used to infer completion by searching the log tail for magic strings
 * that the Python scripts do not actually emit ("自我巡檢與修復完成",
 * "Inspection finished"), so every run polled to its timeout — and because both
 * scripts append to the *same* scanner.log, a `Scan finished` line left by an
 * earlier scan made a later heal run appear complete on its first poll. A
 * structured record removes both failure modes.
 */
function writeRunResult(result: RunResult): void {
  try {
    ensureLogDir();
    const tmp = `${runResultPath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(result), 'utf-8');
    fs.renameSync(tmp, runResultPath());
  } catch (e) {
    console.warn('[Logs] Failed to record run result:', e);
  }
}

/** The most recent run's outcome, or null when none has been recorded. */
export function readRunResult(): RunResult | null {
  try {
    const raw = fs.readFileSync(runResultPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<RunResult>;
    if (typeof parsed?.id !== 'string' || typeof parsed?.task !== 'string') return null;
    return {
      id: parsed.id,
      task: parsed.task,
      code: typeof parsed.code === 'number' ? parsed.code : null,
      signal: typeof parsed.signal === 'string' ? parsed.signal : null,
      finishedAt: parsed.finishedAt || '',
      ok: parsed.ok === true
    };
  } catch {
    return null;
  }
}

/**
 * Reads only the tail of the log file.
 *
 * The log is append-only and never rotated by the Python writers, so a naive
 * `readFileSync(整檔)` grew without bound and could be triggered by any caller.
 * We seek to at most LOG_READ_MAX_BYTES from the end and then keep the last
 * LOG_TAIL_LINES lines, bounding both memory and latency per request.
 */
export function readRecentLogs(): string {
  const logPath = getScannerLogPath();
  try {
    if (!fs.existsSync(logPath)) {
      // The writers rotate with os.replace, which removes scanner.log for the
      // instant between the shift and the new file's creation. A read landing in
      // that window used to render "No logs available" and blank the window even
      // though the history still existed one generation down.
      return readLogTailFrom(`${logPath}.1`);
    }
    const stat = fs.statSync(logPath);
    if (stat.size === 0) return readLogTailFrom(`${logPath}.1`);
    return readLogTailFrom(logPath, stat);
  } catch (e) {
    console.warn('[Logs] Failed to read scanner log:', e);
    return 'No logs available';
  }
}

/** Reads the tail of one log file, or the no-logs placeholder when it is unusable. */
function readLogTailFrom(logPath: string, stat?: fs.Stats): string {
  try {
    if (!fs.existsSync(logPath)) return 'No logs available';
    const st = stat ?? fs.statSync(logPath);
    if (st.size === 0) return 'No logs available';

    const start = Math.max(0, st.size - LOG_READ_MAX_BYTES);
    const length = st.size - start;
    const handle = fs.openSync(logPath, 'r');
    let chunk: string;
    try {
      const buf = Buffer.alloc(length);
      // Use the ACTUAL byte count. The writers rotate the log with os.replace,
      // so the file can shrink between statSync and readSync; a short read left
      // the tail of `buf` zero-filled and the client rendered hundreds of NUL
      // characters (the previous code ignored the return value entirely).
      const bytesRead = fs.readSync(handle, buf, 0, length, start);
      chunk = buf.subarray(0, bytesRead).toString('utf-8');
    } finally {
      fs.closeSync(handle);
    }

    // Drop a possibly truncated first line when we started mid-file.
    if (start > 0) {
      const nl = chunk.indexOf('\n');
      if (nl !== -1) chunk = chunk.slice(nl + 1);
    }

    const lines = chunk.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) return 'No logs available';
    return lines.slice(-LOG_TAIL_LINES).join('\n');
  } catch {
    return 'No logs available';
  }
}

export function appendLog(line: string): void {
  const logPath = getScannerLogPath();
  const timestamp = new Date().toLocaleString('zh-TW', { hour12: false });
  const text = `[${timestamp}] ${line}\n`;

  try {
    fs.appendFileSync(logPath, text, 'utf-8');
    return;
  } catch (e) {
    // A log file the process can READ but not WRITE is the failure mode behind
    // the "window never updates" report: the tail renders fine (so the UI looks
    // healthy and probes pass), while every new line is silently dropped. It
    // happens when scanner.log is owned by someone else — e.g. a root-owned file
    // left on the bind mount, which docker-entrypoint.sh does not re-own because
    // it chowns directories, not the files inside them.
    //
    // Rewriting through a unique temp + rename needs only WRITE on the DIRECTORY,
    // not on the existing file, so the log repairs itself and starts growing
    // again. Only fall back for permission-shaped errors; a genuinely broken
    // filesystem should not be papered over.
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== 'EACCES' && code !== 'EPERM' && code !== 'EROFS') {
      console.warn('[Logs] Failed to append scanner log:', e);
      return;
    }
    try {
      const dir = path.dirname(logPath);
      let existing = '';
      try {
        existing = fs.readFileSync(logPath, 'utf-8');
      } catch {}
      const tmp = path.join(dir, `.scanner.log.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
      fs.writeFileSync(tmp, existing + text, 'utf-8');
      fs.renameSync(tmp, logPath);
      console.warn(`[Logs] scanner.log was not appendable (${code}); replaced it via temp+rename.`);
    } catch (e2) {
      console.warn('[Logs] Failed to append scanner log:', e2);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Authorization for task-triggering endpoints
 * ------------------------------------------------------------------ */

/**
 * The credential required by every endpoint that spawns a maintenance task.
 *
 * Resolution order:
 *  1. `TASK_API_TOKEN`, when the operator sets it (the documented path).
 *  2. Otherwise a random token generated once per boot and printed to the log.
 *
 * Falling back to a *generated* token rather than to "no token" is the whole
 * point. The previous behaviour allowed any request that merely omitted Origin
 * and Sec-Fetch-* headers — which a plain `curl -X POST` does — so an anonymous
 * caller could spawn scan_fayun.py / auto_heal_catalog.py and rewrite the
 * catalog. Fetch Metadata cannot repair that: it is a browser feature, and a
 * non-browser client simply does not send it. Origin/Host are equally
 * client-supplied and were being used to *validate themselves*.
 *
 * Keeping the gate on a secret means a public deployment fails closed, and the
 * operator enables the UI deliberately by setting TASK_API_TOKEN.
 */
let generatedTaskToken: string | null = null;

/** True when the operator configured an explicit token. */
export function isTaskTokenExplicit(): boolean {
  return (process.env.TASK_API_TOKEN || '').trim().length > 0;
}

/** The token task endpoints require; generated once per boot when unset. */
export function getTaskToken(): string {
  const configured = (process.env.TASK_API_TOKEN || '').trim();
  if (configured) return configured;
  if (!generatedTaskToken) {
    generatedTaskToken = crypto.randomBytes(24).toString('hex');
  }
  return generatedTaskToken;
}

/** Test hook: forget a generated token so resolution starts clean. */
export function resetGeneratedTaskToken(): void {
  generatedTaskToken = null;
}

/** A token value from either the dedicated header or `Authorization: Bearer`. */
function presentedTaskToken(request: Request): string {
  const direct = (request.headers.get('x-task-token') || '').trim();
  if (direct) return direct;
  return (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
}

export function authorizeTaskRequest(request: Request): { ok: true } | { ok: false; status: number; message: string } {
  // Cheap defence-in-depth first: a browser tells us when a request is
  // cross-site, and there is never a legitimate cross-site task trigger.
  const fetchSite = (request.headers.get('sec-fetch-site') || '').toLowerCase();
  if (fetchSite === 'cross-site') {
    return { ok: false, status: 403, message: 'Cross-site task trigger rejected' };
  }

  const expected = getTaskToken();
  const provided = presentedTaskToken(request);

  if (!provided) {
    return {
      ok: false,
      status: 401,
      message: isTaskTokenExplicit()
        ? 'Missing task token'
        : 'Missing task token. No TASK_API_TOKEN is configured, so this server generated one at ' +
          'startup — read it from the boot log and send it as the X-Task-Token header. Set ' +
          'TASK_API_TOKEN to choose your own.'
    };
  }

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Length is compared first because timingSafeEqual throws on a mismatch; the
  // length itself is not secret.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, status: 403, message: 'Invalid task token' };
  }
  return { ok: true };
}

/** Metadata describing who currently holds the maintenance lock. */
export interface LockInfo {
  pid: number;
  hostname: string;
  startedAt: string;
  /** Human-readable age, e.g. "3m 20s". */
  age: string;
  /**
   * Opaque ownership token.
   *
   * The holder writes a fresh random token and must present the same token to
   * release. Without it, release was unconditional, so a finishing task could
   * delete a lock a *different* task had already acquired — which I reproduced:
   * `error` and `close` both fire for a failed spawn, so the second release
   * removed the successor's lock and a third task could start concurrently.
   */
  token?: string;
}

/**
 * Outcome of trying to take the lock.
 *
 * This is deliberately not a boolean. The old signature returned `false` for
 * every non-EEXIST failure, so an unwritable `data/logs` (a root-owned volume on
 * a non-root container) was reported to the user as "a task is already running"
 * — a permission problem disguised as a concurrency conflict, with no way to
 * tell them apart from the UI.
 */
export type LockResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'busy'; holder: LockInfo | null }
  | { ok: false; reason: 'unavailable'; error: string };

function formatAge(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Reads and parses the lock file, tolerating the legacy bare-pid format. */
function readLockInfo(): LockInfo | null {
  try {
    const raw = fs.readFileSync(lockFilePath(), 'utf-8').trim();
    if (!raw) return null;
    // Current format is JSON; the original was "<pid>@<iso timestamp>".
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw) as Partial<LockInfo>;
      if (typeof parsed.pid !== 'number') return null;
      return {
        pid: parsed.pid,
        hostname: parsed.hostname || 'unknown',
        startedAt: parsed.startedAt || 'unknown',
        age: parsed.age || 'unknown',
        token: typeof parsed.token === 'string' ? parsed.token : undefined
      };
    }
    const [pidPart, startedAt] = raw.split('@');
    const pid = Number.parseInt(pidPart, 10);
    if (!Number.isFinite(pid)) return null;
    return { pid, hostname: 'unknown', startedAt: startedAt || 'unknown', age: 'unknown' };
  } catch {
    return null;
  }
}

/** True when `pid` is a live process we can see. */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs error checking without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    // EPERM means the process exists but belongs to another user.
    return code === 'EPERM';
  }
}

/**
 * Whether a Python maintenance run currently holds the catalog lock.
 *
 * The Python scripts serialize on `data/courses_db.lock` via `fcntl.flock`
 * (scripts/media_common.py). Node cannot test that lock directly — there is no
 * flock binding — but the holder writes its pid into the file, so liveness can
 * be checked the same way the scan lock does it. This runs in the same container
 * and therefore the same pid namespace, which makes the pid meaningful.
 *
 * Callers must use this to stay out of a maintenance run's way: a run publishes
 * its result and then mirrors it to src/data, so rewriting either file in that
 * window discards the scan's own output and can copy the stale payload back over
 * the good one.
 */
export function isCatalogRunActive(): boolean {
  try {
    const lockPath = path.join(process.cwd(), 'data', 'courses_db.lock');
    const raw = fs.readFileSync(lockPath, 'utf-8');
    const info = JSON.parse(raw) as { pid?: unknown };
    const pid = Number(info?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (pid === process.pid) return false; // Our own writer, not a foreign run.
    return isProcessAlive(pid);
  } catch {
    // Absent or unreadable lock means no run is advertising itself.
    return false;
  }
}

/**
 * Whether an existing lock is still owned by a live task.
 *
 * Two failure modes had to be closed here:
 *
 *  - The lock recorded the *server's* pid, so liveness always passed while the
 *    server ran. After a restart the pid could be reused by an unrelated
 *    process, making a stale lock look permanently live and blocking every
 *    future trigger. The recorded pid is now the Python child's, and the
 *    holder's own pid is only trusted while it is still the recorded one.
 *  - mtime was never refreshed, so a legitimate run longer than LOCK_STALE_MS
 *    was declared dead and a second scan could start concurrently. The holder
 *    now heartbeats the file (see `startLockHeartbeat`).
 */
function lockIsLive(stat: fs.Stats): boolean {
  const info = readLockInfo();

  // Decide on the HOLDER first, and only fall back to age.
  //
  // The age rule used to come first, so a lock whose mtime had gone stale was
  // declared reclaimable even when the recorded holder was demonstrably alive on
  // this host. A run whose heartbeat stalls (blocked event loop, a failed
  // utimesSync, a throttled container) could therefore have its lock taken away
  // by a second maintenance run — two writers on one catalog, which is exactly
  // what this lock exists to prevent.
  if (info) {
    // A pid is only meaningful for a process on this same machine; in a
    // container the lock's pid namespace is our own, so this check is valid.
    const sameHost = info.hostname === os.hostname() || info.hostname === 'unknown';
    if (sameHost) {
      if (isProcessAlive(info.pid)) return true; // Alive holder: never reclaim.
      console.warn(`[Lock] Reclaiming lock from dead pid ${info.pid} (started ${info.startedAt}).`);
      return false;
    }
    // Holder claims another host: liveness is unverifiable, so age decides.
    return Date.now() - stat.mtimeMs < LOCK_STALE_MS;
  }

  // Unparseable: fall back to age so we never wedge forever.
  return Date.now() - stat.mtimeMs < LOCK_STALE_MS;
}

/**
 * Unconditionally removes the lock file.
 *
 * Only safe where ownership is already established: `releaseScanLock` verifies
 * the token first, and boot recovery runs when no task exists. Acquisition must
 * NOT use this — see `tryReclaimStaleLock` for why an unlink based on an earlier
 * `stat` loses the lock to a concurrent peer.
 */
function tryUnlinkLock(): void {
  try {
    if (fs.existsSync(lockFilePath())) fs.unlinkSync(lockFilePath());
  } catch {}
}

/**
 * Atomically claims the right to replace a stale lock.
 *
 * `unlink` on the strength of an earlier `stat` is a TOCTOU: between deciding
 * "this lock is stale" and calling `unlinkSync`, a peer can remove the stale
 * lock and create its OWN fresh one — which we then delete, after which both
 * processes hold the lock and run a catalog-writing job concurrently.
 * Reproduced with 6 processes: 88/215, 85/289 and 74/192 acquisitions were
 * stolen from their owner.
 *
 * Renaming the observed file to a unique name makes the claim atomic: exactly
 * one contender succeeds in renaming THAT inode away, and only the winner may
 * proceed to create a new lock. A contender that lost the race finds the lock
 * gone and simply retries the whole acquisition.
 */
function tryReclaimStaleLock(): boolean {
  const lockPath = lockFilePath();
  const claimPath = `${lockPath}.reclaim.${process.pid}.${crypto.randomUUID()}`;
  try {
    fs.renameSync(lockPath, claimPath);
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return true; // A peer already cleared it.
    return false;
  }
  try {
    fs.unlinkSync(claimPath);
  } catch {
    /* The next boot's stale sweep will clear it. */
  }
  return true;
}

/**
 * Attempts to take the single-writer lock.
 *
 * Records `process.pid` as the *holder* (the server performing the run) because
 * that is the process whose lifetime defines the task. `runTaskScript` replaces
 * it with the Python child's pid once spawned, so a lock abandoned by a killed
 * child is reclaimable while the server keeps running.
 */
export function acquireScanLock(): LockResult {
  const dir = ensureLogDir();
  const lockPath = lockFilePath();

  try {
    // Bounded retries: a lost reclaim race means a peer just changed the lock,
    // so the correct response is to re-evaluate rather than to guess.
    for (let attempt = 0; attempt < 5; attempt++) {
      let stat: fs.Stats | null = null;
      try {
        stat = fs.statSync(lockPath);
      } catch {
        stat = null;
      }

      if (stat) {
        if (lockIsLive(stat)) {
          const info = readLockInfo();
          return {
            ok: false,
            reason: 'busy',
            holder: info ? { ...info, age: formatAge(Date.now() - stat.mtimeMs) } : null
          };
        }
        if (!tryReclaimStaleLock()) continue; // Lost the race; re-evaluate.
      }

      const token = crypto.randomBytes(16).toString('hex');
      try {
        fs.writeFileSync(
          lockPath,
          JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            startedAt: new Date().toISOString(),
            token
          }),
          { flag: 'wx' }
        );
        return { ok: true, token };
      } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException;
        if (err?.code === 'EEXIST') continue; // A peer won; re-evaluate.
        throw e;
      }
    }

    // Every attempt lost a race. Report busy rather than claiming the lock.
    const stat = fs.existsSync(lockPath) ? fs.statSync(lockPath) : null;
    const info = readLockInfo();
    return {
      ok: false,
      reason: 'busy',
      holder: info && stat ? { ...info, age: formatAge(Date.now() - stat.mtimeMs) } : info
    };
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    // EACCES/EROFS/ENOSPC and friends: the lock cannot be written at all. This
    // is an environment problem, not a concurrency one, and must be reported
    // as such instead of masquerading as "already running".
    const detail = `${err?.code || 'UNKNOWN'}: ${err?.message || String(e)}`;
    console.error(`[Lock] Cannot write lock file at ${lockPath} (dir=${dir}): ${detail}`);
    return { ok: false, reason: 'unavailable', error: detail };
  }
}

/**
 * Releases the lock, but only if `token` still owns it.
 *
 * Passing a token makes release idempotent and safe: a task whose lock was
 * already reclaimed and re-acquired by someone else cannot delete the new
 * holder's lock. Omitting it force-releases, which is only correct from boot
 * recovery where no task is running.
 */
export function releaseScanLock(token?: string): void {
  if (token) {
    const info = readLockInfo();
    if (!info || info.token !== token) {
      // Someone else owns the lock now (or it is unreadable); leave it alone.
      return;
    }
  }
  tryUnlinkLock();
}

/**
 * Refreshes the lock's mtime while a task runs.
 *
 * Without this the staleness rule was a hard 30-minute wall clock: a scan that
 * legitimately ran longer was judged dead and a second one could start on top of
 * it. Returns a stop function.
 */
export function startLockHeartbeat(token: string, intervalMs = 60_000): () => void {
  const timer = setInterval(() => {
    const info = readLockInfo();
    if (!info || info.token !== token) return; // Not ours any more; stop touching it.
    try {
      const now = new Date();
      fs.utimesSync(lockFilePath(), now, now);
    } catch {
      /* The file may be gone; the next run will reclaim or recreate it. */
    }
  }, intervalMs);
  // Never keep the process alive just to heartbeat.
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Whether a maintenance task currently holds the lock.
 *
 * Read-only: a GET must not mutate state. This used to call tryUnlinkLock() to
 * reclaim a stale lock, so merely polling the status endpoint could delete a
 * lock file. Reclamation now happens only on the acquisition path and at boot.
 */
export function isScanLocked(): boolean {
  try {
    if (!fs.existsSync(lockFilePath())) return false;
    const stat = fs.statSync(lockFilePath());
    return lockIsLive(stat);
  } catch {
    return false;
  }
}

/**
 * Details of the current lock holder, or null when unlocked.
 *
 * Read-only, for the same reason as `isScanLocked`.
 */
export function getScanLockInfo(): LockInfo | null {
  try {
    if (!fs.existsSync(lockFilePath())) return null;
    const stat = fs.statSync(lockFilePath());
    if (!lockIsLive(stat)) return null;
    const info = readLockInfo();
    return info ? { ...info, age: formatAge(Date.now() - stat.mtimeMs) } : null;
  } catch {
    return null;
  }
}

/**
 * Lock holder details with the ownership token removed, for HTTP responses.
 *
 * `GET /api/scan` and `GET /api/health-check` are unauthenticated — they must be,
 * because the log window is how an operator discovers the boot-generated task
 * token, and gating the log behind that token would be circular. They were
 * therefore publishing `lockHolder.token`, the exact secret needed to authorize
 * a scan, to any anonymous caller. The UI never reads this field; it only shows
 * whether a task is running, so removing the token costs nothing.
 */
export function getScanLockInfoPublic(): Omit<LockInfo, 'token'> | null {
  const info = getScanLockInfo();
  if (!info) return null;
  return stripLockToken(info);
}

/**
 * Returns a copy of `info` without the ownership token.
 *
 * Kept as an explicit delete rather than an object rest-omit so the intent
 * ("this field must never leave the process") is visible and there is no
 * throwaway binding to satisfy the linter.
 */
export function stripLockToken<T extends { token?: string }>(info: T): Omit<T, 'token'> {
  const copy: Record<string, unknown> = { ...info };
  delete copy.token;
  return copy as Omit<T, 'token'>;
}

/**
 * Probes whether the log directory can actually be written.
 *
 * Called once at boot so a misconfigured volume is reported in the logs
 * immediately, rather than surfacing as a confusing error the first time a user
 * presses a maintenance button.
 */
export function checkLogDirWritable(): {
  writable: boolean;
  dir: string;
  error?: string;
  logFileWritable?: boolean;
  logFileWarning?: string;
} {
  const dir = ensureLogDir();
  const probe = path.join(dir, `.write-probe-${process.pid}`);

  // The write and the cleanup must be judged SEPARATELY. Sharing one try meant a
  // failed unlink reported `writable: false` even though the write had just
  // succeeded — direct proof the directory IS writable. Boot then logged
  // "Task log directory is NOT writable ... triggers will fail", sending the
  // operator after the wrong problem, and the un-unlinkable probe accumulated in
  // data/logs. A write failure is the only thing that proves unwritability.
  try {
    fs.writeFileSync(probe, 'ok');
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    return { writable: false, dir, error: `${err?.code || 'UNKNOWN'}: ${err?.message || String(e)}` };
  }

  try {
    fs.unlinkSync(probe);
  } catch (e: unknown) {
    // Writable, but cleanup failed. Reuse one fixed name so repeated boots
    // cannot litter the directory, and surface it as a warning, not a failure.
    const warn =
      `${(e as NodeJS.ErrnoException)?.code || 'UNKNOWN'}: could not remove the write probe ` +
      `${probe}; the directory is writable but stale probes may accumulate`;
    return { writable: true, dir, logFileWritable: true, logFileWarning: warn };
  }

  // The directory probe above is not sufficient. scanner.log is appended IN
  // PLACE, so it needs WRITE on the FILE, while creating the probe only needed
  // WRITE on the DIRECTORY. A root-owned scanner.log on the bind mount therefore
  // passed this check while every append failed — which is exactly how the log
  // window came to look frozen: an old tail rendered fine and boot reported the
  // directory as healthy.
  //
  // This is reported SEPARATELY from `writable`, because the two consequences
  // differ: a bad directory breaks scan/repair triggers, whereas a bad log file
  // only loses log lines (appendLog now rewrites it via temp+rename). Claiming
  // triggers will fail here would be wrong.
  const logPath = scannerLogPath();
  if (fs.existsSync(logPath)) {
    try {
      fs.accessSync(logPath, fs.constants.W_OK);
    } catch (e: unknown) {
      return {
        writable: true,
        dir,
        logFileWritable: false,
        logFileWarning:
          `${(e as NodeJS.ErrnoException)?.code || 'EACCES'}: ${logPath} is not directly ` +
          'appendable (its directory is). Log lines are recovered via temp+rename, so the ' +
          `history keeps growing, but fix the ownership with: chown <app-uid>:<app-gid> ${logPath}`
      };
    }
  }
  return { writable: true, dir, logFileWritable: true };
}

/**
 * Clears a lock left behind by a previous, now-dead process.
 *
 * Runs once at server start. Without this, restarting the container during a
 * scan left a lock that blocked every subsequent trigger for 30 minutes.
 */
export function reclaimOrphanedLock(): LockInfo | null {
  try {
    const lockPath = lockFilePath();
    if (!fs.existsSync(lockPath)) return null;
    const stat = fs.statSync(lockPath);
    if (lockIsLive(stat)) return null;
    const info = readLockInfo();
    tryReclaimStaleLock();
    return info;
  } catch {
    return null;
  }
}

/**
 * Replaces the lock holder's pid with the spawned child's.
 *
 * The lock originally recorded the server's pid, which is alive for the entire
 * server lifetime — so liveness never detected a lock left by a previous
 * incarnation unless the pid happened to be free, and a reused pid made a stale
 * lock look permanently live. Recording the child instead makes the lock
 * reclaimable as soon as the Python process actually exits.
 */
function adoptLockPid(token: string, pid: number): void {
  const info = readLockInfo();
  if (!info || info.token !== token) return;
  try {
    fs.writeFileSync(
      lockFilePath(),
      JSON.stringify({
        pid,
        hostname: info.hostname,
        startedAt: info.startedAt,
        token
      })
    );
  } catch {
    /* Non-fatal: the heartbeat and token still guard correctness. */
  }
}

/**
 * Runs a Python maintenance script detached from the request lifecycle.
 *
 * Uses `spawn` with an output cap instead of `exec`: `exec` buffers all stdout
 * into memory and kills the child once it exceeds `maxBuffer` (1 MB by default).
 * The scan script logs one line per course, so that limit was reachable — and
 * because it writes the database non-atomically, being killed mid-write could
 * leave a truncated courses_db.json. Output is now consumed incrementally and
 * the lock is released from the child's own exit callback.
 *
 * `token` ties this run to the lock it acquired, so releasing cannot delete a
 * successor's lock.
 */
export function runTaskScript(scriptName: string, label: string, token: string, runId?: string): string {
  // The caller's id is echoed back so the UI can tell THIS run's completion from
  // a previous run's leftover log lines.
  const id = runId || crypto.randomBytes(8).toString('hex');
  // Release exactly once, whatever combination of 'error'/'close' fires. Both
  // fire for a failed spawn, and the old unconditional release meant the second
  // one deleted whatever lock a new task had acquired in between.
  let released = false;
  let stopHeartbeat: (() => void) | null = null;
  const release = () => {
    if (released) return;
    released = true;
    if (stopHeartbeat) stopHeartbeat();
    releaseScanLock(token);
  };

  const scriptPath = path.join(process.cwd(), 'scripts', scriptName);
  if (!fs.existsSync(scriptPath)) {
    console.error(`[${label}] Script not found: ${scriptPath}`);
    appendLog(`❌ [系統錯誤] ${label} 找不到腳本: ${scriptName}`);
    writeRunResult({ id, task: label, code: null, signal: null, finishedAt: new Date().toISOString(), ok: false });
    release();
    return id;
  }

  let child: ChildProcess;
  try {
    child = spawn('python3', [scriptPath], {
      cwd: process.cwd(),
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) {
    console.error(`[${label}] Failed to spawn ${scriptName}:`, e);
    appendLog(`❌ [系統錯誤] ${label} 無法啟動 python3: ${(e as Error)?.message || e}`);
    writeRunResult({ id, task: label, code: null, signal: null, finishedAt: new Date().toISOString(), ok: false });
    release();
    return id;
  }

  if (typeof child.pid === 'number') {
    adoptLockPid(token, child.pid);
  }
  stopHeartbeat = startLockHeartbeat(token);

  const MAX_BUFFERED_OUTPUT = 256 * 1024;
  let stdoutBuf = '';
  let stderrBuf = '';

  const flush = (which: 'out' | 'err') => {
    const text = which === 'out' ? stdoutBuf : stderrBuf;
    const trimmed = text.trim();
    const lines = trimmed.split('\n');
    const visible = lines.slice(-50).join('\n');
    if (which === 'out') {
      console.log(`[${label}]`, visible.length > 4000 ? `${visible.slice(-4000)}…` : visible);
      stdoutBuf = '';
    } else {
      console.error(`[${label} Stderr]`, visible.length > 4000 ? `${visible.slice(-4000)}…` : visible);
      stderrBuf = '';
    }
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf-8');
    if (stdoutBuf.length > MAX_BUFFERED_OUTPUT) flush('out');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf-8');
    if (stderrBuf.length > MAX_BUFFERED_OUTPUT) flush('err');
  });

  child.on('error', (err) => {
    console.error(`[${label}] Process error:`, err);
    // A spawn failure (ENOENT for a missing python3) arrives here rather than
    // as a throw, so this is the only place it can be surfaced.
    appendLog(`❌ [系統錯誤] ${label} 無法啟動: ${(err as NodeJS.ErrnoException)?.code || err.message}`);
    writeRunResult({ id, task: label, code: null, signal: null, finishedAt: new Date().toISOString(), ok: false });
    release();
  });

  child.on('close', (code, signal) => {
    if (stdoutBuf.trim()) flush('out');
    if (stderrBuf.trim()) flush('err');
    if (code === 0) {
      console.log(`[${label}] Completed successfully.`);
    } else {
      console.error(`[${label}] Exited with code=${code} signal=${signal}`);
      // Exit code 3 is the Python-side "another task holds the catalog lock".
      const detail = code === 3 ? '（資料庫鎖定中，已有其他維護程序在執行）' : '';
      appendLog(`❌ [系統錯誤] ${label} 結束（code=${code}${signal ? `, signal=${signal}` : ''}）${detail}`);
    }
    writeRunResult({
      id,
      task: label,
      code: typeof code === 'number' ? code : null,
      signal: signal || null,
      finishedAt: new Date().toISOString(),
      ok: code === 0
    });
    release();
  });

  // Detach so an incoming request ending does not tear down the maintenance job.
  child.unref();

  return id;
}

/** Shared reader for the course database, returning summary metadata only. */
export function readDbInfo(): { generated_at: string; total_courses: number; last_auto_healed_at: string; total_repaired: number } {
  const dataDbPath = path.join(/*turbopackIgnore: true*/ process.cwd(), 'data', 'courses_db.json');
  const srcDbPath = path.join(/*turbopackIgnore: true*/ process.cwd(), 'src', 'data', 'courses_db.json');
  const dbPath = fs.existsSync(dataDbPath) ? dataDbPath : srcDbPath;

  const info = { generated_at: 'Unknown', total_courses: 0, last_auto_healed_at: 'Never', total_repaired: 0 };
  try {
    if (fs.existsSync(dbPath)) {
      const data = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
      info.generated_at = data.generated_at || 'Unknown';
      info.total_courses = data.total_courses || (Array.isArray(data.courses) ? data.courses.length : 0) || 0;
      info.last_auto_healed_at = data.last_auto_healed_at || 'Never';
      info.total_repaired = data.total_repaired_courses || 0;
    }
  } catch (e) {
    console.warn('[DB] Failed to read course database info:', e);
  }
  return info;
}
