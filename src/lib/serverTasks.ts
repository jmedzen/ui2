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
    if (!fs.existsSync(logPath)) return 'No logs available';
    const stat = fs.statSync(logPath);
    if (stat.size === 0) return 'No logs available';

    const start = Math.max(0, stat.size - LOG_READ_MAX_BYTES);
    const length = stat.size - start;
    const handle = fs.openSync(logPath, 'r');
    let chunk: string;
    try {
      const buf = Buffer.alloc(length);
      fs.readSync(handle, buf, 0, length, start);
      chunk = buf.toString('utf-8');
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
  } catch (e) {
    console.warn('[Logs] Failed to read scanner log:', e);
    return 'No logs available';
  }
}

export function appendLog(line: string): void {
  const logPath = getScannerLogPath();
  const timestamp = new Date().toLocaleString('zh-TW', { hour12: false });
  try {
    fs.appendFileSync(logPath, `[${timestamp}] ${line}\n`, 'utf-8');
  } catch (e) {
    console.warn('[Logs] Failed to append scanner log:', e);
  }
}

/**
 * Authorization for task-triggering endpoints.
 *
 * These routes spawn Python subprocesses that rewrite the catalog, so they must
 * not be callable by any anonymous visitor. When TASK_API_TOKEN is configured it
 * is required; otherwise only same-origin browser requests are accepted (a
 * cross-site form/fetch cannot forge these headers from a foreign origin).
 */
/** Normalises an authority into a comparable "host:port" pair. */
function normalizeAuthority(hostname: string, protocol: string, port: string): string {
  const effectivePort = port || (protocol === 'https:' ? '443' : '80');
  return `${hostname.toLowerCase()}:${effectivePort}`;
}

/**
 * Collects the authorities this request could legitimately have been made to.
 *
 * `request.url` is NOT reliable for this: behind a reverse proxy (e.g. Caddy
 * terminating TLS in front of `fyweb:8410`) it reports the *internal* address
 * while the browser's Origin reports the public one. Trusting it rejected every
 * legitimate same-origin trigger. The Host / X-Forwarded-Host headers carry the
 * authority the client actually used, so they are checked first.
 */
function allowedAuthorities(request: Request): Set<string> {
  const hostnames = new Set<string>();

  const addAuthority = (value: string | null) => {
    if (!value) return;
    // X-Forwarded-Host may be a comma-separated chain; the first entry is the
    // one the client addressed.
    const first = value.split(',')[0].trim();
    if (!first) return;
    try {
      // Parsed with a scheme so a bare "host:port" is accepted.
      const parsed = new URL(`http://${first}`);
      // An explicit port is authoritative. Without one we cannot know whether
      // the edge terminated on 80 or 443, so both defaults are permitted.
      if (parsed.port) {
        hostnames.add(`${parsed.hostname.toLowerCase()}:${parsed.port}`);
      } else {
        const name = parsed.hostname.toLowerCase();
        hostnames.add(`${name}:80`);
        hostnames.add(`${name}:443`);
      }
    } catch {
      /* ignore malformed authority */
    }
  };

  addAuthority(request.headers.get('x-forwarded-host'));
  addAuthority(request.headers.get('host'));

  try {
    const self = new URL(request.url);
    hostnames.add(normalizeAuthority(self.hostname, self.protocol, self.port));
  } catch {
    /* ignore unparseable request URL */
  }

  return hostnames;
}

export function authorizeTaskRequest(request: Request): { ok: true } | { ok: false; status: number; message: string } {
  const expected = process.env.TASK_API_TOKEN;
  if (expected) {
    const provided =
      request.headers.get('x-task-token') ||
      (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!provided) {
      return { ok: false, status: 401, message: 'Missing task token' };
    }
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, status: 403, message: 'Invalid task token' };
    }
    return { ok: true };
  }

  // Fetch Metadata is set by the browser and cannot be forged from JS. A
  // same-origin (or user-initiated) request is exactly what we want to allow.
  const fetchSite = (request.headers.get('sec-fetch-site') || '').toLowerCase();
  if (fetchSite === 'same-origin' || fetchSite === 'none') {
    return { ok: true };
  }
  if (fetchSite) {
    return { ok: false, status: 403, message: 'Cross-site task trigger rejected' };
  }

  // No Fetch Metadata (older browser or non-browser client): fall back to
  // comparing Origin against the authorities the client could have used.
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      const parsedOrigin = new URL(origin);
      const originAuthority = normalizeAuthority(parsedOrigin.hostname, parsedOrigin.protocol, parsedOrigin.port);
      if (!allowedAuthorities(request).has(originAuthority)) {
        return { ok: false, status: 403, message: 'Cross-origin task trigger rejected' };
      }
    } catch {
      return { ok: false, status: 403, message: 'Malformed Origin header' };
    }
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
  | { ok: true }
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
        age: parsed.age || 'unknown'
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
 * Whether an existing lock is still owned by a live task.
 *
 * The previous implementation trusted mtime alone, so any lock file younger
 * than 30 minutes blocked new runs even when the process that created it had
 * exited — which is exactly what a `docker compose restart` leaves behind.
 * A long scan therefore became permanently un-triggerable.
 */
function lockIsLive(stat: fs.Stats): boolean {
  if (Date.now() - stat.mtimeMs >= LOCK_STALE_MS) return false;

  const info = readLockInfo();
  if (!info) {
    // Unparseable: fall back to age so we never wedge forever.
    return Date.now() - stat.mtimeMs < LOCK_STALE_MS;
  }

  // A pid is only meaningful for a process on this same machine; in a container
  // the lock's pid namespace is our own, so this check is valid there too.
  const sameHost = info.hostname === os.hostname() || info.hostname === 'unknown';
  if (sameHost && !isProcessAlive(info.pid)) {
    console.warn(`[Lock] Reclaiming lock from dead pid ${info.pid} (started ${info.startedAt}).`);
    return false;
  }
  return true;
}

function tryUnlinkLock(): void {
  try {
    if (fs.existsSync(lockFilePath())) fs.unlinkSync(lockFilePath());
  } catch {}
}

/** Attempts to take the single-writer lock. */
export function acquireScanLock(): LockResult {
  const dir = ensureLogDir();
  const lockPath = lockFilePath();

  try {
    if (fs.existsSync(lockPath)) {
      const stat = fs.statSync(lockPath);
      if (lockIsLive(stat)) {
        const info = readLockInfo();
        return {
          ok: false,
          reason: 'busy',
          holder: info ? { ...info, age: formatAge(Date.now() - stat.mtimeMs) } : null
        };
      }
      // Stale or orphaned lock; reclaim it.
      tryUnlinkLock();
    }

    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() }),
      { flag: 'wx' }
    );
    return { ok: true };
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code === 'EEXIST') {
      const stat = fs.existsSync(lockPath) ? fs.statSync(lockPath) : null;
      const info = readLockInfo();
      return {
        ok: false,
        reason: 'busy',
        holder: info && stat ? { ...info, age: formatAge(Date.now() - stat.mtimeMs) } : info
      };
    }
    // EACCES/EROFS/ENOSPC and friends: the lock cannot be written at all. This
    // is an environment problem, not a concurrency one, and must be reported
    // as such instead of masquerading as "already running".
    const detail = `${err?.code || 'UNKNOWN'}: ${err?.message || String(e)}`;
    console.error(`[Lock] Cannot write lock file at ${lockPath} (dir=${dir}): ${detail}`);
    return { ok: false, reason: 'unavailable', error: detail };
  }
}

export function releaseScanLock(): void {
  tryUnlinkLock();
}

/** Whether a maintenance task currently holds the lock. */
export function isScanLocked(): boolean {
  try {
    if (!fs.existsSync(lockFilePath())) return false;
    const stat = fs.statSync(lockFilePath());
    if (!lockIsLive(stat)) {
      tryUnlinkLock();
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Details of the current lock holder, or null when unlocked. */
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
 * Probes whether the log directory can actually be written.
 *
 * Called once at boot so a misconfigured volume is reported in the logs
 * immediately, rather than surfacing as a confusing error the first time a user
 * presses a maintenance button.
 */
export function checkLogDirWritable(): { writable: boolean; dir: string; error?: string } {
  const dir = ensureLogDir();
  const probe = path.join(dir, `.write-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return { writable: true, dir };
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    return { writable: false, dir, error: `${err?.code || 'UNKNOWN'}: ${err?.message || String(e)}` };
  }
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
    tryUnlinkLock();
    return info;
  } catch {
    return null;
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
 */
export function runTaskScript(scriptName: string, label: string): void {
  const scriptPath = path.join(process.cwd(), 'scripts', scriptName);
  if (!fs.existsSync(scriptPath)) {
    console.error(`[${label}] Script not found: ${scriptPath}`);
    releaseScanLock();
    return;
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
    releaseScanLock();
    return;
  }

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
    releaseScanLock();
  });

  child.on('close', (code, signal) => {
    if (stdoutBuf.trim()) flush('out');
    if (stderrBuf.trim()) flush('err');
    if (code === 0) {
      console.log(`[${label}] Completed successfully.`);
    } else {
      console.error(`[${label}] Exited with code=${code} signal=${signal}`);
    }
    releaseScanLock();
  });

  // Detach so an incoming request ending does not tear down the maintenance job.
  child.unref();
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
