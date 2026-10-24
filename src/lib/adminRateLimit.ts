import { clientKeyFor } from './clientIp';

/**
 * Fixed-window brute-force budget for the admin login endpoint.
 *
 * Two counters are kept:
 *  - a per-client attempt budget (successful and failed attempts), so a single
 *    noisy client is slowed down;
 *  - a global failure counter, so rotating source addresses does not turn into
 *    an unbounded scrypt CPU workload.
 *
 * There is deliberately no permanent account lock: an attacker must not be able
 * to lock the single administrator out forever. A short window plus scrypt's
 * cost is the trade-off.
 */

const WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_PER_CLIENT_ATTEMPTS = 10;
const DEFAULT_GLOBAL_FAILURES = 500;
const MAX_BUCKETS = 5000;
const BUCKETS_KEY = '__fayunAdminLoginBuckets';
const GLOBAL_KEY = '__fayunAdminLoginGlobalFailures';

interface Bucket {
  count: number;
  resetAt: number;
}

type RateLimitGlobal = typeof globalThis & {
  [BUCKETS_KEY]?: Map<string, Bucket>;
  [GLOBAL_KEY]?: Bucket;
};

function globalState(): RateLimitGlobal {
  return globalThis as RateLimitGlobal;
}

function buckets(): Map<string, Bucket> {
  const g = globalState();
  if (!g[BUCKETS_KEY]) g[BUCKETS_KEY] = new Map();
  return g[BUCKETS_KEY];
}

function perClientLimit(): number {
  const rawValue = (process.env.ADMIN_LOGIN_MAX_ATTEMPTS || '').trim();
  const raw = rawValue ? Number(rawValue) : NaN;
  if (!Number.isFinite(raw)) return DEFAULT_PER_CLIENT_ATTEMPTS;
  return Math.min(100, Math.max(1, Math.floor(raw)));
}

function globalFailureLimit(): number {
  const rawValue = (process.env.ADMIN_LOGIN_GLOBAL_FAILURES || '').trim();
  const raw = rawValue ? Number(rawValue) : NaN;
  if (!Number.isFinite(raw)) return DEFAULT_GLOBAL_FAILURES;
  return Math.min(10_000, Math.max(10, Math.floor(raw)));
}

function prune(now: number): void {
  const store = buckets();
  for (const [key, bucket] of store) {
    if (bucket.resetAt <= now) store.delete(key);
  }
  if (store.size <= MAX_BUCKETS) return;

  const byExpiry = [...store.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
  for (const [key] of byExpiry) {
    if (store.size <= MAX_BUCKETS) break;
    store.delete(key);
  }
}

function retryAfterSeconds(resetAt: number, now: number): number {
  return Math.max(1, Math.ceil((resetAt - now) / 1000));
}

export interface LoginAttemptResult {
  ok: boolean;
  key: string;
  retryAfter?: number;
}

/**
 * Counts one login attempt against the per-client budget.
 *
 * Call this before running scrypt. A denied attempt does not run the password
 * hash, which is what keeps a login flood from becoming a CPU exhaustion bug.
 */
export interface LoginAttemptOptions {
  /**
   * Id from a valid trusted-device cookie (adminSession.verifyDeviceCookie).
   * The attempt is then budgeted per device and is exempt from the global
   * failure ceiling, so a flood from other addresses cannot lock out a browser
   * that has already logged in successfully.
   */
  deviceId?: string | null;
  /**
   * Skip the global ceiling for a caller that already holds an authenticated
   * session (password/TOTP management). The per-client budget still applies.
   */
  bypassGlobal?: boolean;
}

export function consumeAdminLoginAttempt(
  request: Request,
  options: LoginAttemptOptions = {}
): LoginAttemptResult {
  const key = options.deviceId ? `device:${options.deviceId}` : clientKeyFor(request);
  const exemptFromGlobal = Boolean(options.deviceId) || options.bypassGlobal === true;
  const now = Date.now();
  prune(now);

  const global = globalState()[GLOBAL_KEY];
  if (!exemptFromGlobal && global && global.resetAt > now && global.count >= globalFailureLimit()) {
    return { ok: false, key, retryAfter: retryAfterSeconds(global.resetAt, now) };
  }

  const store = buckets();
  let bucket = store.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    store.set(key, bucket);
  }

  if (bucket.count >= perClientLimit()) {
    return { ok: false, key, retryAfter: retryAfterSeconds(bucket.resetAt, now) };
  }

  bucket.count += 1;
  return { ok: true, key };
}

/** Records a failed password check in the global failure counter. */
export function recordAdminLoginFailure(): void {
  const now = Date.now();
  const g = globalState();
  let bucket = g[GLOBAL_KEY];
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    g[GLOBAL_KEY] = bucket;
  }
  bucket.count += 1;
}

/** Clears a client's attempt budget after a successful login. */
export function resetAdminLoginFailures(key: string): void {
  buckets().delete(key);
}

/** Test hook. */
export function resetAdminLoginRateLimitForTests(): void {
  buckets().clear();
  delete globalState()[GLOBAL_KEY];
}
