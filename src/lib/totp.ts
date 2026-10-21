import crypto from 'crypto';

/**
 * RFC 6238 TOTP support for the admin account.
 *
 * The implementation is intentionally dependency-free and small:
 *  - HMAC-SHA1, 6 digits, 30-second timestep (the compatible defaults);
 *  - one timestep of clock skew in each direction;
 *  - a process-local replay guard so an observed code cannot be used twice.
 *
 * TOTP secrets are stored as RFC 4648 base32, without padding. That is the
 * format authenticator applications expect, and it avoids an extra encoding
 * layer in the credential file.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BASE32_LOOKUP = new Map<string, number>(
  [...BASE32_ALPHABET].map((character, index) => [character, index])
);

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_DEFAULT_ISSUER = 'Fayun UI2';
export const TOTP_DEFAULT_ACCOUNT = 'admin';

const DEFAULT_SECRET_BYTES = 20;
const MIN_SECRET_BYTES = 10;
const MAX_SECRET_BYTES = 64;
const DEFAULT_WINDOW = 1;
const MAX_WINDOW = 2;
const REPLAY_STORE_KEY = '__fayunAdminTotpReplay';
const MAX_REPLAY_ENTRIES = 2000;

export type TotpSecretResult =
  | { ok: true; secret: string; bytes: Buffer }
  | { ok: false; error: string };

export type TotpVerifyResult =
  | { ok: true; step: number }
  | { ok: false; reason: 'malformed' | 'invalid-secret' | 'mismatch' };

export type TotpConsumeResult =
  | { ok: true; step: number }
  | { ok: false; reason: 'malformed' | 'invalid-secret' | 'mismatch' | 'replay' };

type ReplayGlobal = typeof globalThis & {
  [REPLAY_STORE_KEY]?: Map<string, number>;
};

function replayStore(): Map<string, number> {
  const g = globalThis as ReplayGlobal;
  if (!g[REPLAY_STORE_KEY]) g[REPLAY_STORE_KEY] = new Map();
  return g[REPLAY_STORE_KEY];
}

/** Normalizes whitespace/hyphens and removes optional base32 padding. */
export function normalizeTotpSecret(value: string): string {
  return value
    .trim()
    .replace(/[\s-]/g, '')
    .replace(/=+$/g, '')
    .toUpperCase();
}

/** Validates and decodes a base32 TOTP secret. */
export function parseTotpSecret(value: string): TotpSecretResult {
  const secret = normalizeTotpSecret(value);
  if (!secret) return { ok: false, error: 'TOTP secret is empty' };

  let bits = 0;
  let accumulator = 0;
  const bytes: number[] = [];

  for (const character of secret) {
    const index = BASE32_LOOKUP.get(character);
    if (index === undefined) {
      return { ok: false, error: 'TOTP secret must be base32 (A-Z and 2-7)' };
    }
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 0xff);
    }
  }

  if (bytes.length < MIN_SECRET_BYTES) {
    return { ok: false, error: `TOTP secret must decode to at least ${MIN_SECRET_BYTES} bytes` };
  }
  if (bytes.length > MAX_SECRET_BYTES) {
    return { ok: false, error: `TOTP secret must decode to at most ${MAX_SECRET_BYTES} bytes` };
  }

  return { ok: true, secret, bytes: Buffer.from(bytes) };
}

function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let accumulator = 0;
  let output = '';
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(accumulator >>> bits) & 31];
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(accumulator << (5 - bits)) & 31];
  }
  return output;
}

/** Generates a 160-bit secret, matching the common authenticator default. */
export function generateTotpSecret(byteLength = DEFAULT_SECRET_BYTES): string {
  const size = Math.min(MAX_SECRET_BYTES, Math.max(MIN_SECRET_BYTES, Math.floor(byteLength)));
  return base32Encode(crypto.randomBytes(size));
}

function hotp(key: Buffer, counter: number): string {
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new Error('invalid TOTP counter');
  }
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const digest = crypto.createHmac('sha1', key).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

function stepForTime(timestamp: number): number {
  return Math.floor(timestamp / 1000 / TOTP_PERIOD_SECONDS);
}

/** Computes the code for a specific timestamp (used by tests and diagnostics). */
export function generateTotpCode(secret: string, timestamp = Date.now()): string {
  const parsed = parseTotpSecret(secret);
  if (!parsed.ok) throw new Error(parsed.error);
  return hotp(parsed.bytes, stepForTime(timestamp));
}

function windowFromEnv(): number {
  const rawValue = (process.env.ADMIN_TOTP_WINDOW || '').trim();
  const raw = rawValue ? Number(rawValue) : NaN;
  if (!Number.isFinite(raw)) return DEFAULT_WINDOW;
  return Math.min(MAX_WINDOW, Math.max(0, Math.floor(raw)));
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Verifies a 6-digit code without consuming it. */
export function verifyTotpCode(
  secret: string,
  code: string,
  options: { now?: number; window?: number } = {}
): TotpVerifyResult {
  const normalizedCode = String(code || '').replace(/\s/g, '');
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(normalizedCode)) {
    return { ok: false, reason: 'malformed' };
  }

  const parsed = parseTotpSecret(secret);
  if (!parsed.ok) return { ok: false, reason: 'invalid-secret' };

  const currentStep = stepForTime(options.now ?? Date.now());
  const window = Math.min(
    MAX_WINDOW,
    Math.max(0, Math.floor(options.window ?? windowFromEnv()))
  );
  const offsets = [0];
  for (let distance = 1; distance <= window; distance += 1) {
    offsets.push(-distance, distance);
  }

  for (const offset of offsets) {
    const step = currentStep + offset;
    if (step < 0) continue;
    if (constantTimeEqual(hotp(parsed.bytes, step), normalizedCode)) {
      return { ok: true, step };
    }
  }

  return { ok: false, reason: 'mismatch' };
}

function replayKey(secret: string): string {
  return crypto.createHash('sha256').update(normalizeTotpSecret(secret)).digest('base64url');
}

/**
 * Verifies a code and records its timestep so it cannot be replayed.
 *
 * The warning window deliberately still accepts a previous timestep for clock
 * skew, but the replay guard requires the new code's step to be strictly newer
 * than the last consumed one. Two logins inside the same 30-second window
 * therefore need two different codes; that is the intended trade-off.
 */
export function verifyAndConsumeTotpCode(
  secret: string,
  code: string,
  options: { now?: number; window?: number } = {}
): TotpConsumeResult {
  const verified = verifyTotpCode(secret, code, options);
  if (!verified.ok) return verified;

  const store = replayStore();
  const key = replayKey(secret);
  const lastStep = store.get(key);
  if (lastStep !== undefined && verified.step <= lastStep) {
    return { ok: false, reason: 'replay' };
  }

  store.set(key, verified.step);
  while (store.size > MAX_REPLAY_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
  return verified;
}

/** Builds an otpauth:// URI suitable for manual entry or a QR generator. */
export function buildTotpUri(
  secret: string,
  options: { issuer?: string; account?: string } = {}
): string {
  const parsed = parseTotpSecret(secret);
  if (!parsed.ok) throw new Error(parsed.error);

  const issuer = (options.issuer || TOTP_DEFAULT_ISSUER).trim() || TOTP_DEFAULT_ISSUER;
  const account = (options.account || TOTP_DEFAULT_ACCOUNT).trim() || TOTP_DEFAULT_ACCOUNT;
  const label = `${issuer}:${account}`;
  const query = new URLSearchParams({
    secret: parsed.secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS)
  });

  return `otpauth://totp/${encodeURIComponent(label)}?${query.toString()}`;
}

/** Test hook: forget all consumed timesteps. */
export function resetTotpReplayForTests(): void {
  replayStore().clear();
}
