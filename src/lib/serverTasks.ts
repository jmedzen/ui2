import { spawn, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/** Name reported in logs/UI for the scanner task. */
export const SCAN_TASK = 'scan';
export const HEAL_TASK = 'heal';

const LOG_DIR = path.join(/*turbopackIgnore: true*/ process.cwd(), 'data', 'logs');
const SCANNER_LOG = path.join(LOG_DIR, 'scanner.log');
const LOCK_FILE = path.join(LOG_DIR, 'scan.lock');

/** Maximum number of trailing log lines returned to the client. */
const LOG_TAIL_LINES = 500;
/** Hard cap on how much of the log file we are willing to read per request. */
const LOG_READ_MAX_BYTES = 2 * 1024 * 1024;
/** A lock older than this is considered abandoned (crashed process). */
const LOCK_STALE_MS = 30 * 60 * 1000;

export function ensureLogDir(): string {
  if (!fs.existsSync(LOG_DIR)) {
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    } catch {}
  }
  return LOG_DIR;
}

export function getScannerLogPath(): string {
  ensureLogDir();
  return SCANNER_LOG;
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

/** Attempts to take the single-writer lock. Returns false when already held. */
export function acquireScanLock(): boolean {
  ensureLogDir();
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const stat = fs.statSync(LOCK_FILE);
      if (Date.now() - stat.mtimeMs < LOCK_STALE_MS) {
        return false;
      }
      // Stale lock from a crashed run; reclaim it.
      fs.unlinkSync(LOCK_FILE);
    }
    fs.writeFileSync(LOCK_FILE, `${process.pid}@${new Date().toISOString()}\n`, { flag: 'wx' });
    return true;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'EEXIST') return false;
    console.warn('[Lock] Failed to acquire scan lock:', e);
    return false;
  }
}

export function releaseScanLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
  } catch {}
}

export function isScanLocked(): boolean {
  try {
    if (!fs.existsSync(LOCK_FILE)) return false;
    const stat = fs.statSync(LOCK_FILE);
    if (Date.now() - stat.mtimeMs >= LOCK_STALE_MS) {
      fs.unlinkSync(LOCK_FILE);
      return false;
    }
    return true;
  } catch {
    return false;
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
