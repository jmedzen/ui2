import {
  readAdminCredential,
  passwordFingerprint,
  isAdminTotpEnvConfigured,
  type AdminCredentialResult
} from './adminPassword';
import {
  getAdminSession,
  type AdminSessionRecord
} from './adminSession';
import {
  getTaskToken,
  isTaskTokenExplicit,
  isValidTaskToken,
  presentedTaskToken
} from './serverTasks';
import { isTrustedProxy } from './clientIp';
import { resolveSiteUrl } from './site';

/**
 * Authorization for administrative endpoints.
 *
 * There is deliberately NO same-origin fallback here. Host, Origin and
 * Sec-Fetch-* are request-supplied values; treating them as a credential let a
 * non-browser client authorize itself. Admin actions require either a valid
 * server-side session or the explicitly configured automation token.
 */

export type AdminAuthFailureCode =
  | 'ADMIN_LOGIN_REQUIRED'
  | 'ADMIN_CSRF_REJECTED'
  | 'ADMIN_NOT_CONFIGURED'
  | 'ADMIN_UNAVAILABLE'
  | 'INVALID_AUTOMATION_TOKEN';

export type AdminAuthResult =
  | { ok: true; via: 'session'; expiresAt: number }
  | { ok: true; via: 'token' }
  | { ok: false; status: 401 | 403 | 503; code: AdminAuthFailureCode; message: string };

export type AdminAuthOptions = {
  /** Automation callers may use TASK_API_TOKEN. Disable for session-only actions. */
  allowToken?: boolean;
  /** State-changing requests must pass the CSRF checks. */
  requireCsrf?: boolean;
};

function firstHeaderValue(request: Request, name: string): string {
  const raw = request.headers.get(name);
  if (!raw) return '';
  return raw.split(',')[0]?.trim() || '';
}

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return `${url.protocol}//${url.host.toLowerCase()}`;
  } catch {
    return null;
  }
}

function originFromReferer(referer: string): string | null {
  if (!referer) return null;
  try {
    const url = new URL(referer);
    return `${url.protocol}//${url.host.toLowerCase()}`;
  } catch {
    return null;
  }
}

function configuredOrigins(): string[] {
  const raw = (process.env.ADMIN_ALLOWED_ORIGINS || '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((value) => normalizeOrigin(value.trim()))
    .filter((value): value is string => Boolean(value));
}

/**
 * The host the browser believes it is talking to.
 *
 * X-Forwarded-Host is request-supplied, so it is honoured ONLY with
 * TRUST_PROXY=1 — the contract the README documents. The previous version had a
 * dead `isTrustedProxy()` branch followed by an unconditional read of the same
 * header, so the setting changed nothing and any direct caller could choose the
 * host its own Origin was compared against. Behind a proxy without
 * TRUST_PROXY, set ADMIN_ALLOWED_ORIGINS instead.
 */
function requestHostForOriginCheck(request: Request): string {
  if (isTrustedProxy()) {
    const forwarded = firstHeaderValue(request, 'x-forwarded-host');
    if (forwarded) return forwarded.toLowerCase();
  }
  try {
    return new URL(request.url).host.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Checks that a state-changing admin request came from an allowed origin.
 *
 * Browsers cannot forge Origin/Referer on a cross-site form or fetch. If an
 * explicit allowlist is configured, it is compared exactly (scheme + host);
 * otherwise the host must match the request/proxy host. The latter mirrors the
 * historical preload check and works behind Caddy without extra configuration.
 */
export function isAdminOriginAllowed(request: Request): boolean {
  const given =
    normalizeOrigin(request.headers.get('origin') || '') ||
    originFromReferer(request.headers.get('referer') || '');
  if (!given) return false;

  const allowlist = configuredOrigins();
  if (allowlist.length > 0) return allowlist.includes(given);
  // An explicitly configured allowlist with no valid entries must fail closed,
  // not silently fall back to host matching.
  if ((process.env.ADMIN_ALLOWED_ORIGINS || '').trim()) return false;

  const expectedHost = requestHostForOriginCheck(request);
  if (!expectedHost) return false;
  try {
    return new URL(given).host.toLowerCase() === expectedHost;
  } catch {
    return false;
  }
}

/** True for a browser-declared cross-site request. */
export function isCrossSiteRequest(request: Request): boolean {
  return (request.headers.get('sec-fetch-site') || '').toLowerCase() === 'cross-site';
}

/**
 * CSRF gate for cookie-authenticated state changes.
 *
 * SameSite=Strict already blocks most cases; the custom header additionally
 * forces a CORS preflight, which this app never authorizes.
 */
export function checkAdminCsrf(request: Request): boolean {
  if (isCrossSiteRequest(request)) return false;
  if (request.headers.get('x-admin-request') !== '1') return false;
  return isAdminOriginAllowed(request);
}

function unavailableResult(credential: AdminCredentialResult): AdminAuthResult {
  if (credential.ok) {
    return {
      ok: false,
      status: 401,
      code: 'ADMIN_LOGIN_REQUIRED',
      message: 'Admin login required'
    };
  }
  if (credential.reason === 'missing') {
    if (isTaskTokenExplicit()) {
      return {
        ok: false,
        status: 401,
        code: 'ADMIN_LOGIN_REQUIRED',
        message: 'Admin login required'
      };
    }
    return {
      ok: false,
      status: 503,
      code: 'ADMIN_NOT_CONFIGURED',
      message:
        'No admin password is configured. Run "node scripts/admin-password.mjs" on the server, ' +
        'or set ADMIN_PASSWORD_HASH, then try again.'
    };
  }
  return {
    ok: false,
    status: 503,
    code: 'ADMIN_UNAVAILABLE',
    message: 'Admin credentials are unavailable or invalid. Check the server log for details.'
  };
}

function sessionResult(
  request: Request,
  credential: AdminCredentialResult,
  options: AdminAuthOptions
): AdminAuthResult | null {
  if (!credential.ok) return null;
  const session: AdminSessionRecord | null = getAdminSession(
    request,
    passwordFingerprint(credential.hash)
  );
  if (!session) return null;

  if (options.requireCsrf !== false && !checkAdminCsrf(request)) {
    return {
      ok: false,
      status: 403,
      code: 'ADMIN_CSRF_REJECTED',
      message: 'Request rejected: missing or invalid CSRF/origin headers'
    };
  }

  return { ok: true, via: 'session', expiresAt: session.expiresAt };
}

/** Authorizes a state-changing admin endpoint. */
export function authorizeAdminRequest(
  request: Request,
  options: AdminAuthOptions = {}
): AdminAuthResult {
  const allowToken = options.allowToken !== false;

  // A legitimate cross-site admin request does not exist. Reject it before any
  // credential handling, including token handling.
  if (isCrossSiteRequest(request)) {
    return {
      ok: false,
      status: 403,
      code: 'ADMIN_CSRF_REJECTED',
      message: 'Cross-site admin request rejected'
    };
  }

  const credential = readAdminCredential();
  const fromSession = sessionResult(request, credential, options);
  if (fromSession) return fromSession;

  if (allowToken) {
    const provided = presentedTaskToken(request);
    if (provided) {
      if (isValidTaskToken(provided)) return { ok: true, via: 'token' };
      return {
        ok: false,
        status: 403,
        code: 'INVALID_AUTOMATION_TOKEN',
        message: 'Invalid automation token'
      };
    }
  }

  return unavailableResult(credential);
}

/**
 * Optional authorization for read-only endpoints (status/logs).
 *
 * Returns null when the request is anonymous; never throws a 401 for a public
 * status page. Cross-site requests get no admin detail even if a cookie happens
 * to be attached.
 */
export function getOptionalAdminAuth(
  request: Request,
  options: AdminAuthOptions = {}
): Extract<AdminAuthResult, { ok: true }> | null {
  if (isCrossSiteRequest(request)) return null;

  const credential = readAdminCredential();
  if (credential.ok) {
    const session = getAdminSession(request, passwordFingerprint(credential.hash));
    if (session) return { ok: true, via: 'session', expiresAt: session.expiresAt };
  }

  if (options.allowToken !== false) {
    const provided = presentedTaskToken(request);
    if (provided && isValidTaskToken(provided)) return { ok: true, via: 'token' };
  }

  return null;
}

export interface AdminAuthStatus {
  authenticated: boolean;
  configured: boolean;
  expiresAt: number | null;
  tokenConfigured: boolean;
  /** Only file-backed credentials can be changed from the UI. */
  passwordChangeable: boolean;
  /** Revealed only to an authenticated session. */
  totpEnabled: boolean;
  /** False for environment-managed TOTP and read-only password sources. */
  totpManageable: boolean;
  /**
   * Canonical origin behind og:url and <link rel="canonical">, surfaced here so
   * the settings panel renders from one already-fetched payload instead of
   * opening its own request/effect.
   */
  siteUrl: string;
  siteUrlSource: 'environment' | 'settings' | 'default';
  /** True when SITE_URL pins the origin and the panel must be read-only. */
  siteUrlLocked: boolean;
  error?: 'invalid' | 'unavailable';
}

/** Session status for the UI. Never includes a hash, secret, token or file path. */
export function getAdminAuthStatus(request: Request): AdminAuthStatus {
  const credential = readAdminCredential();
  const tokenConfigured = isTaskTokenExplicit();
  const siteUrlValue = resolveSiteUrl();

  if (!credential.ok) {
    return {
      authenticated: false,
      configured: false,
      expiresAt: null,
      tokenConfigured,
      passwordChangeable: false,
      totpEnabled: false,
      totpManageable: false,
      siteUrl: siteUrlValue.origin,
      siteUrlSource: siteUrlValue.source,
      siteUrlLocked: siteUrlValue.source === 'environment',
      ...(credential.reason === 'missing' ? {} : { error: credential.reason })
    };
  }

  const session = getAdminSession(request, passwordFingerprint(credential.hash));
  const authenticated = Boolean(session);
  return {
    authenticated,
    configured: true,
    expiresAt: session?.expiresAt ?? null,
    tokenConfigured,
    passwordChangeable: credential.source === 'ADMIN_PASSWORD_FILE',
    totpEnabled: authenticated && Boolean(credential.totpSecret),
    totpManageable:
      authenticated &&
      credential.source === 'ADMIN_PASSWORD_FILE' &&
      !isAdminTotpEnvConfigured(),
    siteUrl: siteUrlValue.origin,
    siteUrlSource: siteUrlValue.source,
    siteUrlLocked: siteUrlValue.source === 'environment'
  };
}

/** Exposed for diagnostics/tests without leaking the token value. */
export function hasAutomationToken(): boolean {
  return getTaskToken().length > 0;
}

/* ------------------------------------------------------------------ *
 * Small bounded JSON body reader
 * ------------------------------------------------------------------ */

export type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; message: string };

/**
 * Reads a JSON request body with a hard byte cap.
 *
 * `request.json()` materialises the whole body first; a login endpoint should
 * not be a memory primitive. The reader also stops an oversized chunked body
 * that has no Content-Length.
 */
export async function readJsonBodyLimited(
  request: Request,
  maxBytes = 4096
): Promise<JsonBodyResult> {
  const declared = Number(request.headers.get('content-length') || '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await request.body?.cancel();
    } catch {}
    return { ok: false, status: 413, message: 'Request body too large' };
  }

  const reader = request.body?.getReader();
  if (!reader) return { ok: false, status: 400, message: 'Missing request body' };

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {}
        return { ok: false, status: 413, message: 'Request body too large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, message: 'Failed to read request body' };
  }

  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf-8');
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, message: 'Malformed JSON body' };
  }
}
