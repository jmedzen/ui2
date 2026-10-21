import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { parseTotpSecret } from './totp';
// The length bounds live in a browser-safe module so the UI can share them;
// the import supplies the local bindings, the export keeps the old import path.
import {
  MAX_ADMIN_PASSWORD_LENGTH,
  MIN_ADMIN_PASSWORD_LENGTH
} from './passwordPolicy';

export { MAX_ADMIN_PASSWORD_LENGTH, MIN_ADMIN_PASSWORD_LENGTH } from './passwordPolicy';

/**
 * Admin password storage and verification.
 *
 * The password is never stored in plaintext. The only persisted form is a
 * self-describing scrypt hash:
 *
 *   scrypt:<N>:<r>:<p>:<keylen>:<base64url salt>:<base64url hash>
 *
 * Colons are used instead of the more common `$` separators because Docker
 * Compose interprets `$NAME` in environment values. A hash such as
 * `scrypt$N=...` would silently lose pieces when pasted into compose.yaml.
 */

const DEFAULT_SCRYPT_N = 32768;
const DEFAULT_SCRYPT_R = 8;
const DEFAULT_SCRYPT_P = 1;
const DEFAULT_SCRYPT_KEYLEN = 64;
const MIN_SCRYPT_N = 1 << 14;
const MAX_SCRYPT_N = 1 << 16;
const MAX_SCRYPT_R = 16;
const MAX_SCRYPT_P = 4;
const MIN_KEYLEN = 32;
const MAX_KEYLEN = 128;
const MAX_SCRYPT_MEMORY_BYTES = 128 * 1024 * 1024;
const MAX_CREDENTIAL_BYTES = 16 * 1024;

const SCRYPT_ALGORITHM = 'scrypt';
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export type AdminCredentialSource =
  | 'ADMIN_PASSWORD_HASH'
  | 'ADMIN_PASSWORD_HASH_FILE'
  | 'ADMIN_PASSWORD_FILE';

export interface AdminCredential {
  hash: string;
  source: AdminCredentialSource;
  updatedAt?: string;
  /** Active TOTP secret, if 2FA is enabled. */
  totpSecret?: string;
  /** Where the active TOTP secret came from. */
  totpSource?: 'env' | 'file';
  totpUpdatedAt?: string;
  /** Non-secret operational warning, e.g. overly permissive file mode. */
  warning?: string;
}

export type AdminCredentialResult =
  | ({ ok: true } & AdminCredential)
  | { ok: false; reason: 'missing' | 'invalid' | 'unavailable'; message: string };

export interface ScryptHashParams {
  N: number;
  r: number;
  p: number;
  keylen: number;
  salt: Buffer;
  hash: Buffer;
}

export type ParsedScryptHash =
  | { ok: true; params: ScryptHashParams }
  | { ok: false; error: string };

const scryptAsync = promisify(crypto.scrypt) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions
) => Promise<Buffer>;

/** Default credential file, resolved lazily so tests can redirect it. */
export function getAdminPasswordFile(): string {
  const configured = (process.env.ADMIN_PASSWORD_FILE || '').trim();
  return configured || path.join(process.cwd(), 'data', 'admin.json');
}

/** True when the operator explicitly chose a credential file path. */
export function hasExplicitAdminPasswordFile(): boolean {
  return (process.env.ADMIN_PASSWORD_FILE || '').trim().length > 0;
}

function scryptMaxmem(N: number, r: number, p: number): number {
  // Node requires maxmem to comfortably exceed 128*N*r. Give it headroom and
  // keep a hard ceiling so a malformed hash cannot request gigabytes.
  const required = 128 * N * r + 128 * r * p + 1024;
  return Math.max(64 * 1024 * 1024, Math.min(MAX_SCRYPT_MEMORY_BYTES * 2, required * 2));
}

/** Parses and bounds-checks the stored hash format. */
export function parseScryptHash(value: string): ParsedScryptHash {
  const trimmed = value.trim();
  const parts = trimmed.split(':');
  if (parts.length !== 7) {
    return { ok: false, error: 'expected 7 colon-separated fields' };
  }
  const [algorithm, nRaw, rRaw, pRaw, keylenRaw, saltRaw, hashRaw] = parts;
  if (algorithm !== SCRYPT_ALGORITHM) {
    return { ok: false, error: `unsupported algorithm "${algorithm}"` };
  }

  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  const keylen = Number(keylenRaw);

  if (!Number.isInteger(N) || N < MIN_SCRYPT_N || N > MAX_SCRYPT_N || (N & (N - 1)) !== 0) {
    return { ok: false, error: `N must be a power of two between ${MIN_SCRYPT_N} and ${MAX_SCRYPT_N}` };
  }
  if (!Number.isInteger(r) || r < 1 || r > MAX_SCRYPT_R) {
    return { ok: false, error: `r must be between 1 and ${MAX_SCRYPT_R}` };
  }
  if (!Number.isInteger(p) || p < 1 || p > MAX_SCRYPT_P) {
    return { ok: false, error: `p must be between 1 and ${MAX_SCRYPT_P}` };
  }
  if (!Number.isInteger(keylen) || keylen < MIN_KEYLEN || keylen > MAX_KEYLEN) {
    return { ok: false, error: `keylen must be between ${MIN_KEYLEN} and ${MAX_KEYLEN}` };
  }
  if (128 * N * r > MAX_SCRYPT_MEMORY_BYTES) {
    return { ok: false, error: 'scrypt parameters exceed the memory budget' };
  }
  if (!BASE64URL_PATTERN.test(saltRaw) || !BASE64URL_PATTERN.test(hashRaw)) {
    return { ok: false, error: 'salt and hash must be base64url' };
  }

  const salt = Buffer.from(saltRaw, 'base64url');
  const hash = Buffer.from(hashRaw, 'base64url');
  if (salt.length < 16 || salt.length > 64) {
    return { ok: false, error: 'salt must be 16-64 bytes' };
  }
  if (hash.length !== keylen) {
    return { ok: false, error: 'hash length does not match keylen' };
  }

  return { ok: true, params: { N, r, p, keylen, salt, hash } };
}

/** Creates a hash for tests and one-off tooling. Production uses the CLI. */
export function createScryptHash(
  password: string,
  options: { N?: number; r?: number; p?: number; keylen?: number } = {}
): string {
  const N = options.N ?? DEFAULT_SCRYPT_N;
  const r = options.r ?? DEFAULT_SCRYPT_R;
  const p = options.p ?? DEFAULT_SCRYPT_P;
  const keylen = options.keylen ?? DEFAULT_SCRYPT_KEYLEN;
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, keylen, {
    N,
    r,
    p,
    maxmem: scryptMaxmem(N, r, p)
  });
  return [
    SCRYPT_ALGORITHM,
    String(N),
    String(r),
    String(p),
    String(keylen),
    salt.toString('base64url'),
    hash.toString('base64url')
  ].join(':');
}

/** Async variant used by HTTP routes so a password change does not block the event loop. */
export async function createScryptHashAsync(
  password: string,
  options: { N?: number; r?: number; p?: number; keylen?: number } = {}
): Promise<string> {
  const N = options.N ?? DEFAULT_SCRYPT_N;
  const r = options.r ?? DEFAULT_SCRYPT_R;
  const p = options.p ?? DEFAULT_SCRYPT_P;
  const keylen = options.keylen ?? DEFAULT_SCRYPT_KEYLEN;
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(Buffer.from(password, 'utf8'), salt, keylen, {
    N,
    r,
    p,
    maxmem: scryptMaxmem(N, r, p)
  });
  return [
    SCRYPT_ALGORITHM,
    String(N),
    String(r),
    String(p),
    String(keylen),
    salt.toString('base64url'),
    hash.toString('base64url')
  ].join(':');
}

export type PasswordValidation =
  | { ok: true }
  | { ok: false; message: string };

/** Shared password policy for the CLI, HTTP routes and tests. */
export function validateAdminPassword(password: unknown): PasswordValidation {
  if (typeof password !== 'string' || password.length === 0) {
    return { ok: false, message: 'Password is required' };
  }
  if (password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      message: `Password must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters`
    };
  }
  if (password.length > MAX_ADMIN_PASSWORD_LENGTH) {
    return { ok: false, message: `Password must be at most ${MAX_ADMIN_PASSWORD_LENGTH} characters` };
  }
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(password)) {
    return { ok: false, message: 'Password must not contain control characters' };
  }
  return { ok: true };
}

/** Verifies a password against one stored hash. */
export async function verifyPasswordAgainstHash(
  password: string,
  storedHash: string
): Promise<{ ok: true } | { ok: false; reason: 'invalid-hash' | 'mismatch' }> {
  const parsed = parseScryptHash(storedHash);
  if (!parsed.ok) return { ok: false, reason: 'invalid-hash' };

  const { N, r, p, keylen, salt, hash } = parsed.params;
  let candidate: Buffer;
  try {
    candidate = await scryptAsync(Buffer.from(password, 'utf8'), salt, keylen, {
      N,
      r,
      p,
      maxmem: scryptMaxmem(N, r, p)
    });
  } catch {
    return { ok: false, reason: 'invalid-hash' };
  }

  if (candidate.length !== hash.length) return { ok: false, reason: 'mismatch' };
  return crypto.timingSafeEqual(candidate, hash)
    ? { ok: true }
    : { ok: false, reason: 'mismatch' };
}

/**
 * Stable, non-reversible fingerprint of the stored hash.
 *
 * Sessions remember the fingerprint they were created under. When the password
 * file is rotated, existing sessions stop matching and are rejected without
 * needing to restart the process.
 */
export function passwordFingerprint(storedHash: string): string {
  return crypto.createHash('sha256').update(storedHash).digest('base64url');
}

/** True when the operator pinned TOTP through the environment. */
export function isAdminTotpEnvConfigured(): boolean {
  return (process.env.ADMIN_TOTP_SECRET || '').trim().length > 0;
}

/**
 * Applies the optional environment TOTP secret over any file value.
 *
 * `ADMIN_TOTP_SECRET` is an additional credential, not a password source. It
 * lets read-only/CI deployments enable 2FA without a writable credential file.
 * An invalid value fails closed rather than silently disabling 2FA.
 */
function applyEnvTotp(credential: AdminCredentialResult): AdminCredentialResult {
  if (!credential.ok) return credential;
  const raw = (process.env.ADMIN_TOTP_SECRET || '').trim();
  if (!raw) return credential;

  const parsed = parseTotpSecret(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      reason: 'invalid',
      message: `ADMIN_TOTP_SECRET is invalid: ${parsed.error}`
    };
  }
  return {
    ...credential,
    totpSecret: parsed.secret,
    totpSource: 'env'
  };
}

interface ExistingTotpFields {
  totpSecret?: string;
  totpUpdatedAt?: string;
}

/**
 * Reads the TOTP fields from an existing credential file.
 *
 * Password rotation must preserve 2FA enrollment. A malformed existing file is
 * an error, not an excuse to silently erase the second factor.
 */
function readExistingTotpFields(filePath: string): ExistingTotpFields {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
    throw e;
  }

  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return {};

  let parsed: { totpSecret?: unknown; totpUpdatedAt?: unknown };
  try {
    parsed = JSON.parse(trimmed) as typeof parsed;
  } catch {
    throw new Error(`${filePath} is not valid JSON`);
  }

  if (parsed.totpSecret === undefined || parsed.totpSecret === null) {
    return {
      totpUpdatedAt:
        typeof parsed.totpUpdatedAt === 'string' ? parsed.totpUpdatedAt : undefined
    };
  }
  if (typeof parsed.totpSecret !== 'string') {
    throw new Error(`${filePath} has a non-string totpSecret`);
  }

  const normalized = parseTotpSecret(parsed.totpSecret);
  if (!normalized.ok) {
    throw new Error(`${filePath} contains an invalid TOTP secret: ${normalized.error}`);
  }
  return {
    totpSecret: normalized.secret,
    totpUpdatedAt:
      typeof parsed.totpUpdatedAt === 'string' ? parsed.totpUpdatedAt : undefined
  };
}

export interface WriteAdminCredentialOptions {
  passwordHash: string;
  /**
   * `undefined` preserves the file's existing enrollment, `null` removes it,
   * and a string installs a new secret. Password rotation must use the default.
   */
  totpSecret?: string | null;
  totpUpdatedAt?: string | null;
  updatedAt?: string;
  /** The app runs as an unprivileged user; writing as root creates an unreadable file. */
  refuseRoot?: boolean;
}

/**
 * Atomically writes the credential JSON with mode 0600.
 *
 * Temp file + fsync + rename keeps a crash from leaving a half-written file.
 * Existing TOTP enrollment is preserved when only the password changes.
 */
export function writeAdminCredentialFile(
  filePath: string,
  options: WriteAdminCredentialOptions
): void {
  const parsedHash = parseScryptHash(options.passwordHash);
  if (!parsedHash.ok) {
    throw new Error(`Refusing to write an invalid password hash: ${parsedHash.error}`);
  }

  if (
    options.refuseRoot &&
    typeof process.getuid === 'function' &&
    process.getuid() === 0
  ) {
    throw new Error(
      'Refusing to write as root: the application runs as an unprivileged user and ' +
        'would not be able to read a root-owned 0600 file.'
    );
  }

  const existing = readExistingTotpFields(filePath);
  let totpSecret: string | undefined;
  let totpUpdatedAt: string | undefined;

  if (options.totpSecret === undefined) {
    totpSecret = existing.totpSecret;
    totpUpdatedAt =
      options.totpUpdatedAt === null
        ? undefined
        : options.totpUpdatedAt || existing.totpUpdatedAt;
  } else if (options.totpSecret !== null) {
    const parsed = parseTotpSecret(options.totpSecret);
    if (!parsed.ok) {
      throw new Error(`Refusing to write an invalid TOTP secret: ${parsed.error}`);
    }
    totpSecret = parsed.secret;
    totpUpdatedAt =
      options.totpUpdatedAt === null
        ? undefined
        : options.totpUpdatedAt || new Date().toISOString();
  }

  const payload = JSON.stringify(
    {
      version: 1,
      algorithm: 'scrypt',
      passwordHash: options.passwordHash,
      ...(totpSecret ? { totpSecret } : {}),
      ...(totpSecret && totpUpdatedAt ? { totpUpdatedAt } : {}),
      updatedAt: options.updatedAt || new Date().toISOString()
    },
    null,
    2
  ) + '\n';

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const temp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );

  const handle = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(handle, payload, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }

  try {
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* Platforms without POSIX modes. */
    }
  } catch (e) {
    try {
      fs.unlinkSync(temp);
    } catch {}
    throw e;
  }
}

function permissionWarning(filePath: string): string | undefined {
  if (process.platform === 'win32') return undefined;
  try {
    const mode = fs.statSync(filePath).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      return `${filePath} is readable by group/other (mode ${mode.toString(8)}); chmod 600 is recommended`;
    }
  } catch {
    /* The read path already reports unreadable files. */
  }
  return undefined;
}

function readFileCredential(
  filePath: string,
  source: AdminCredentialSource
): AdminCredentialResult {
  let raw: string;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return { ok: false, reason: 'unavailable', message: `${filePath} is not a regular file` };
    }
    if (stat.size > MAX_CREDENTIAL_BYTES) {
      return { ok: false, reason: 'invalid', message: `${filePath} is unexpectedly large` };
    }
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return {
        ok: false,
        reason: hasExplicitAdminPasswordFile() || source === 'ADMIN_PASSWORD_HASH_FILE' ? 'unavailable' : 'missing',
        message: `Admin password file not found: ${filePath}`
      };
    }
    return {
      ok: false,
      reason: 'unavailable',
      message: `Cannot read admin password file ${filePath}: ${code || 'unknown error'}`
    };
  }

  const trimmed = raw.trim();
  let storedHash = trimmed;
  let updatedAt: string | undefined;
  let totpSecret: string | undefined;
  let totpUpdatedAt: string | undefined;

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as {
        version?: unknown;
        passwordHash?: unknown;
        updatedAt?: unknown;
        totpSecret?: unknown;
        totpUpdatedAt?: unknown;
      };
      if (parsed.version !== undefined && parsed.version !== 1) {
        return { ok: false, reason: 'invalid', message: `${filePath} has an unsupported version` };
      }
      if (typeof parsed.passwordHash !== 'string' || !parsed.passwordHash.trim()) {
        return { ok: false, reason: 'invalid', message: `${filePath} does not contain a passwordHash` };
      }
      storedHash = parsed.passwordHash.trim();
      updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined;

      if (parsed.totpSecret !== undefined && parsed.totpSecret !== null) {
        if (typeof parsed.totpSecret !== 'string') {
          return { ok: false, reason: 'invalid', message: `${filePath} has a non-string totpSecret` };
        }
        const totp = parseTotpSecret(parsed.totpSecret);
        if (!totp.ok) {
          return {
            ok: false,
            reason: 'invalid',
            message: `${filePath} contains an invalid TOTP secret: ${totp.error}`
          };
        }
        totpSecret = totp.secret;
        totpUpdatedAt =
          typeof parsed.totpUpdatedAt === 'string' ? parsed.totpUpdatedAt : undefined;
      }
    } catch {
      return { ok: false, reason: 'invalid', message: `${filePath} is not valid JSON` };
    }
  }

  const parsed = parseScryptHash(storedHash);
  if (!parsed.ok) {
    return { ok: false, reason: 'invalid', message: `${filePath} contains an invalid scrypt hash: ${parsed.error}` };
  }

  return {
    ok: true,
    hash: storedHash,
    source,
    updatedAt,
    ...(totpSecret
      ? { totpSecret, totpSource: 'file' as const, totpUpdatedAt }
      : {}),
    warning: permissionWarning(filePath)
  };
}

/**
 * Resolves the active credential.
 *
 * Precedence is intentionally explicit:
 *   1. ADMIN_PASSWORD_HASH          (immutable / CI deployments)
 *   2. ADMIN_PASSWORD_HASH_FILE     (Docker secret, raw hash)
 *   3. ADMIN_PASSWORD_FILE          (default data/admin.json)
 *
 * An explicitly configured source that is missing/unreadable fails closed
 * instead of silently falling through to a weaker or stale source.
 */
export function readAdminCredential(): AdminCredentialResult {
  const envHash = (process.env.ADMIN_PASSWORD_HASH || '').trim();
  if (envHash) {
    const parsed = parseScryptHash(envHash);
    if (!parsed.ok) {
      return { ok: false, reason: 'invalid', message: `ADMIN_PASSWORD_HASH is invalid: ${parsed.error}` };
    }
    return applyEnvTotp({ ok: true, hash: envHash, source: 'ADMIN_PASSWORD_HASH' });
  }

  const hashFile = (process.env.ADMIN_PASSWORD_HASH_FILE || '').trim();
  if (hashFile) {
    return applyEnvTotp(readFileCredential(hashFile, 'ADMIN_PASSWORD_HASH_FILE'));
  }

  return applyEnvTotp(readFileCredential(getAdminPasswordFile(), 'ADMIN_PASSWORD_FILE'));
}

/** Convenience for the boot log and the session endpoint. */
export function isAdminPasswordConfigured(): boolean {
  return readAdminCredential().ok;
}
