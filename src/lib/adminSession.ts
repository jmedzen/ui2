import crypto from 'crypto';
import { isTrustedProxy } from './clientIp';

/**
 * Opaque, server-side admin sessions.
 *
 * The cookie carries a random 32-byte token. The process keeps only a SHA-256
 * digest of it, so a heap dump or an accidental log statement cannot be
 * replayed as a cookie. Sessions are in memory on purpose:
 *
 *  - the deployment is a single container / single Node process;
 *  - restarting the server therefore revokes every session, which is a useful
 *    property for an admin credential;
 *  - there is no signing secret to manage or leak.
 *
 * If this is ever scaled to multiple replicas, replace this store with a shared
 * one (or a signed cookie plus a revocation list). Do not assume these sessions
 * are visible across processes.
 */

export const ADMIN_SESSION_COOKIE = 'fayun_admin_session';
const SESSION_STORE_KEY = '__fayunAdminSessions';
const SESSION_SWEEP_KEY = '__fayunAdminSessionSweepAt';
const MAX_SESSIONS = 100;
const SWEEP_INTERVAL_MS = 60 * 1000;
const DEFAULT_TTL_MINUTES = 12 * 60;
const MIN_TTL_MINUTES = 5;
const MAX_TTL_MINUTES = 7 * 24 * 60;

export interface AdminSessionRecord {
  createdAt: number;
  expiresAt: number;
  /** Fingerprint of the password hash this session was created under. */
  fingerprint: string;
}

type SessionGlobal = typeof globalThis & {
  [SESSION_STORE_KEY]?: Map<string, AdminSessionRecord>;
  [SESSION_SWEEP_KEY]?: number;
};

function globalStore(): SessionGlobal {
  return globalThis as SessionGlobal;
}

function sessions(): Map<string, AdminSessionRecord> {
  const g = globalStore();
  if (!g[SESSION_STORE_KEY]) g[SESSION_STORE_KEY] = new Map();
  return g[SESSION_STORE_KEY];
}

function ttlMs(): number {
  const rawValue = (process.env.ADMIN_SESSION_TTL_MINUTES || '').trim();
  const raw = rawValue ? Number(rawValue) : NaN;
  const minutes = Number.isFinite(raw) ? raw : DEFAULT_TTL_MINUTES;
  const clamped = Math.min(MAX_TTL_MINUTES, Math.max(MIN_TTL_MINUTES, Math.floor(minutes)));
  return clamped * 60 * 1000;
}

function tokenDigest(token: string): string {
  return crypto.createHash('sha256').update(token).digest('base64url');
}

function sweep(now: number, force = false): void {
  const g = globalStore();
  const last = g[SESSION_SWEEP_KEY] ?? 0;
  if (!force && now - last < SWEEP_INTERVAL_MS) return;
  g[SESSION_SWEEP_KEY] = now;

  const store = sessions();
  for (const [key, record] of store) {
    if (record.expiresAt <= now) store.delete(key);
  }

  // Only the admin can create sessions, so this cap is about bounding damage
  // from a bug or a stolen password rather than an anonymous memory attack.
  while (store.size > MAX_SESSIONS) {
    const oldest = [...store.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (!oldest) break;
    store.delete(oldest[0]);
  }
}

export interface CreatedAdminSession {
  token: string;
  expiresAt: number;
  ttlSeconds: number;
}

/** Creates a new session; callers must set the returned cookie. */
export function createAdminSession(fingerprint: string): CreatedAdminSession {
  const now = Date.now();
  const expiresAt = now + ttlMs();
  const token = crypto.randomBytes(32).toString('base64url');
  const record: AdminSessionRecord = { createdAt: now, expiresAt, fingerprint };

  const store = sessions();
  store.set(tokenDigest(token), record);
  sweep(now, true);

  return { token, expiresAt, ttlSeconds: Math.floor((expiresAt - now) / 1000) };
}

/** Returns the valid session for this request, or null. */
export function getAdminSession(
  request: Request,
  currentPasswordFingerprint: string
): AdminSessionRecord | null {
  const token = readCookie(request, ADMIN_SESSION_COOKIE);
  if (!token) return null;

  const key = tokenDigest(token);
  const store = sessions();
  const record = store.get(key);
  if (!record) return null;

  const now = Date.now();
  if (record.expiresAt <= now || record.fingerprint !== currentPasswordFingerprint) {
    // A fingerprint mismatch means the password was rotated; do not let an old
    // cookie survive until its natural expiry.
    store.delete(key);
    return null;
  }

  sweep(now);
  return record;
}

/** Removes the session referenced by the request cookie, if any. */
export function destroyAdminSession(request: Request): void {
  const token = readCookie(request, ADMIN_SESSION_COOKIE);
  if (!token) return;
  sessions().delete(tokenDigest(token));
}

/** Revokes every session (used by password changes and tests). */
export function destroyAllAdminSessions(): void {
  sessions().clear();
}

/** Test hook: starts from a clean store. */
export function resetAdminSessionsForTests(): void {
  destroyAllAdminSessions();
  globalStore()[SESSION_SWEEP_KEY] = 0;
}

/** Reads a single cookie without pulling in a cookie-parsing dependency. */
export function readCookie(request: Request, name: string): string {
  const raw = request.headers.get('cookie');
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return part.slice(eq + 1).trim();
    }
  }
  return '';
}

/**
 * Whether this request arrived over HTTPS.
 *
 * Behind Caddy, the app itself speaks HTTP, so X-Forwarded-Proto is only
 * trusted when TRUST_PROXY is enabled (the compose file binds 8410 to
 * loopback, so this is the documented deployment).
 */
export function isHttpsRequest(request: Request): boolean {
  if (isTrustedProxy()) {
    const forwarded = (request.headers.get('x-forwarded-proto') || '').split(',')[0]?.trim().toLowerCase();
    if (forwarded === 'https') return true;
    if (forwarded === 'http') return false;
  }
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Transport policy for password submission.
 *
 * Production refuses cleartext HTTP unless the operator explicitly opts in for
 * a trusted LAN. This prevents a password from being sent in the clear because
 * a proxy header was missing.
 */
export function checkAdminTransport(request: Request): { ok: true } | { ok: false; message: string } {
  if (isHttpsRequest(request)) return { ok: true };
  if (process.env.ADMIN_ALLOW_INSECURE_HTTP === '1') return { ok: true };
  if (process.env.NODE_ENV !== 'production') return { ok: true };
  return {
    ok: false,
    message:
      'Admin login requires HTTPS. Put the app behind a TLS proxy, or set ' +
      'ADMIN_ALLOW_INSECURE_HTTP=1 only for a trusted, isolated network.'
  };
}

function cookieSecure(request: Request): boolean {
  const configured = (process.env.ADMIN_COOKIE_SECURE || '').trim().toLowerCase();
  if (configured === '1' || configured === 'true') return true;
  if (configured === '0' || configured === 'false') return false;
  return isHttpsRequest(request);
}

/** Serializes the session cookie with the recommended attributes. */
export function serializeAdminSessionCookie(
  session: CreatedAdminSession,
  request: Request
): string {
  const attributes = [
    `${ADMIN_SESSION_COOKIE}=${session.token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${session.ttlSeconds}`,
    `Expires=${new Date(session.expiresAt).toUTCString()}`
  ];
  if (cookieSecure(request)) attributes.push('Secure');
  return attributes.join('; ');
}

/** Serializes a cookie that removes the session from the browser. */
export function serializeClearAdminSessionCookie(request: Request): string {
  const attributes = [
    `${ADMIN_SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT'
  ];
  if (cookieSecure(request)) attributes.push('Secure');
  return attributes.join('; ');
}
