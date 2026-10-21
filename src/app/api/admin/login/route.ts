import { NextResponse } from 'next/server';
import {
  readAdminCredential,
  verifyPasswordAgainstHash,
  passwordFingerprint
} from '@/lib/adminPassword';
import {
  checkAdminCsrf,
  readJsonBodyLimited
} from '@/lib/adminAuth';
import {
  checkAdminTransport,
  createAdminSession,
  serializeAdminSessionCookie
} from '@/lib/adminSession';
import {
  consumeAdminLoginAttempt,
  recordAdminLoginFailure,
  resetAdminLoginFailures
} from '@/lib/adminRateLimit';
import { appendAdminAudit } from '@/lib/adminAudit';
import { verifyAndConsumeTotpCode } from '@/lib/totp';
import { clientKeyFor } from '@/lib/clientIp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' } as const;
const MAX_PASSWORD_LENGTH = 256;

/** Small, uniform delay on failure so response timing is not a useful oracle. */
function failureDelay(): Promise<void> {
  const ms = 150 + Math.floor(Math.random() * 150);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonError(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
  extra: Record<string, unknown> = {}
): NextResponse {
  return NextResponse.json(
    { error: message, code, ...extra },
    { status, headers: { ...NO_STORE, ...headers } }
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  const ip = clientKeyFor(request);
  const userAgent = request.headers.get('user-agent') || '';

  // Login is a state-changing request with a password in the body: require the
  // same origin/CSRF headers as every other admin POST.
  if (!checkAdminCsrf(request)) {
    appendAdminAudit('login_failure', { reason: 'csrf_or_origin', ip, ua: userAgent });
    return jsonError(403, 'ADMIN_CSRF_REJECTED', 'Request rejected: missing or invalid CSRF/origin headers');
  }

  const transport = checkAdminTransport(request);
  if (!transport.ok) {
    appendAdminAudit('login_failure', { reason: 'insecure_transport', ip, ua: userAgent });
    return jsonError(503, 'ADMIN_HTTPS_REQUIRED', transport.message);
  }

  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  const mediaType = contentType.split(';')[0]?.trim();
  if (mediaType !== 'application/json') {
    return jsonError(415, 'ADMIN_JSON_REQUIRED', 'Content-Type must be application/json');
  }

  const body = await readJsonBodyLimited(request, 4096);
  if (!body.ok) {
    return jsonError(body.status, 'ADMIN_BAD_BODY', body.message);
  }

  const value =
    body.value && typeof body.value === 'object'
      ? (body.value as { password?: unknown; code?: unknown })
      : {};
  const password = value.password;
  const rawCode = value.code;
  const code = typeof rawCode === 'string' ? rawCode.trim() : '';

  if (typeof password !== 'string' || password.length === 0) {
    return jsonError(400, 'ADMIN_PASSWORD_REQUIRED', 'Password is required');
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return jsonError(400, 'ADMIN_PASSWORD_TOO_LONG', 'Password is too long');
  }
  if (rawCode !== undefined && typeof rawCode !== 'string') {
    return jsonError(400, 'ADMIN_TOTP_CODE_INVALID', 'TOTP code must be a string');
  }
  if (code.length > 32) {
    return jsonError(400, 'ADMIN_TOTP_CODE_INVALID', 'TOTP code is too long');
  }

  const credential = readAdminCredential();
  if (!credential.ok) {
    appendAdminAudit('login_failure', {
      reason: credential.reason,
      ip,
      ua: userAgent
    });
    if (credential.reason === 'missing') {
      return jsonError(
        503,
        'ADMIN_NOT_CONFIGURED',
        'No admin password is configured. Run "node scripts/admin-password.mjs" on the server, ' +
          'or set ADMIN_PASSWORD_HASH, then try again.'
      );
    }
    return jsonError(
      503,
      'ADMIN_UNAVAILABLE',
      'Admin credentials are unavailable or invalid. Check the server log for details.'
    );
  }

  // Count the attempt before running scrypt. This is what prevents a login
  // flood from turning into an unbounded CPU/memory workload.
  const attempt = consumeAdminLoginAttempt(request);
  if (!attempt.ok) {
    appendAdminAudit('login_failure', {
      reason: 'rate_limited',
      ip,
      retryAfter: attempt.retryAfter
    });
    return jsonError(429, 'ADMIN_RATE_LIMITED', 'Too many login attempts. Try again later.', {
      'Retry-After': String(attempt.retryAfter || 60)
    });
  }

  const verified = await verifyPasswordAgainstHash(password, credential.hash);
  if (!verified.ok) {
    recordAdminLoginFailure();
    appendAdminAudit('login_failure', {
      reason: verified.reason,
      ip,
      ua: userAgent
    });
    await failureDelay();
    return jsonError(401, 'ADMIN_BAD_PASSWORD', 'Invalid password');
  }

  if (credential.totpSecret) {
    if (!code) {
      appendAdminAudit('login_failure', {
        reason: 'totp_required',
        ip,
        ua: userAgent
      });
      return jsonError(401, 'ADMIN_TOTP_REQUIRED', 'TOTP verification code required', {}, {
        totpRequired: true
      });
    }

    const totp = verifyAndConsumeTotpCode(credential.totpSecret, code);
    if (!totp.ok) {
      recordAdminLoginFailure();
      appendAdminAudit('login_failure', {
        reason: totp.reason,
        ip,
        ua: userAgent
      });
      await failureDelay();
      return jsonError(
        401,
        totp.reason === 'replay' ? 'ADMIN_TOTP_REPLAY' : 'ADMIN_BAD_TOTP',
        totp.reason === 'replay'
          ? 'This verification code was already used. Wait for the next code.'
          : 'Invalid TOTP verification code'
      );
    }
  }

  resetAdminLoginFailures(attempt.key);

  const session = createAdminSession(passwordFingerprint(credential.hash));
  appendAdminAudit('login_success', {
    source: credential.source,
    ip,
    ua: userAgent,
    expiresAt: new Date(session.expiresAt).toISOString()
  });

  return NextResponse.json(
    { ok: true, expiresAt: session.expiresAt },
    {
      headers: {
        ...NO_STORE,
        'Set-Cookie': serializeAdminSessionCookie(session, request)
      }
    }
  );
}
