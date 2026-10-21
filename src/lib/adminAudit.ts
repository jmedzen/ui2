import fs from 'fs';
import path from 'path';

/**
 * Append-only administrative audit trail.
 *
 * This file is intentionally separate from scanner.log: it contains login
 * attempts and admin actions, is never exposed by an HTTP endpoint, and is
 * written best-effort. A failure to audit must not block an admin action.
 */

const DEFAULT_MAX_LOG_BYTES = 1024 * 1024;
const DEFAULT_MAX_LOG_FILES = 5;
const MIN_MAX_LOG_BYTES = 1;
const MAX_MAX_LOG_BYTES = 64 * 1024 * 1024;
const MIN_MAX_LOG_FILES = 1;
const MAX_MAX_LOG_FILES = 20;

function positiveInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const raw = value ? Number(value) : NaN;
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(raw)));
}

function maxLogBytes(): number {
  return positiveInteger(
    (process.env.ADMIN_AUDIT_MAX_BYTES || '').trim(),
    DEFAULT_MAX_LOG_BYTES,
    MIN_MAX_LOG_BYTES,
    MAX_MAX_LOG_BYTES
  );
}

function maxLogFiles(): number {
  return positiveInteger(
    (process.env.ADMIN_AUDIT_MAX_FILES || '').trim(),
    DEFAULT_MAX_LOG_FILES,
    MIN_MAX_LOG_FILES,
    MAX_MAX_LOG_FILES
  );
}

function auditLogPath(): string | null {
  const configured = (process.env.ADMIN_AUDIT_LOG || '').trim();
  if (configured === 'off' || configured === '0' || configured === 'false') return null;
  if (configured) return configured;
  return path.join(process.cwd(), 'data', 'logs', 'admin.log');
}

function safeValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[\r\n\t]/g, ' ').slice(0, 300);
}

/**
 * Shifts admin.log through a bounded set of numbered backups.
 *
 * The previous single-backup rename silently destroyed the only historical
 * copy on every rotation. Numbered generations make the rotation predictable
 * and give an operator enough history to investigate an incident without an
 * external log shipper.
 */
function rotateIfNeeded(logPath: string): void {
  try {
    const stat = fs.statSync(logPath);
    if (stat.size < maxLogBytes()) return;

    const generations = maxLogFiles();
    // Remove the oldest generation first so rename() never has to overwrite it.
    try {
      fs.unlinkSync(`${logPath}.${generations}`);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
    }

    for (let index = generations - 1; index >= 1; index -= 1) {
      try {
        fs.renameSync(`${logPath}.${index}`, `${logPath}.${index + 1}`);
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
      }
    }

    fs.renameSync(logPath, `${logPath}.1`);
  } catch {
    /* Missing file or an unwritable directory: append will report it below. */
  }
}

/** Records one structured event. Never pass passwords, hashes, or cookies. */
export function appendAdminAudit(
  event: string,
  fields: Record<string, unknown> = {}
): void {
  const logPath = auditLogPath();
  if (!logPath) return;

  const pairs = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${safeValue(value)}`)
    .join(' ');

  const line = `[${new Date().toISOString()}] event=${safeValue(event)}${pairs ? ` ${pairs}` : ''}\n`;

  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    rotateIfNeeded(logPath);
    fs.appendFileSync(logPath, line, { encoding: 'utf-8', mode: 0o600 });
    try {
      fs.chmodSync(logPath, 0o600);
    } catch {
      /* Platforms without POSIX modes; the append above still succeeded. */
    }
  } catch (e) {
    // The audit trail is valuable but not a precondition for serving admin
    // requests. Surface it in container logs and continue.
    console.warn('[AdminAudit] Failed to write audit record:', e);
  }
}
