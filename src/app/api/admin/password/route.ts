import { NextResponse } from 'next/server';
import {
  createScryptHashAsync,
  getAdminPasswordFile,
  passwordFingerprint,
  readAdminCredential,
  validateAdminPassword,
  verifyPasswordAgainstHash,
  writeAdminCredentialFile
} from '@/lib/adminPassword';
import {
  authorizeAdminRequest,
  readJsonBodyLimited
} from '@/lib/adminAuth';
import {
  checkAdminTransport,
  createAdminSession,
  destroyAllAdminSessions,
  serializeAdminSessionCookie
} from '@/lib/adminSession';
import {
  consumeAdminLoginAttempt,
  recordAdminLoginFailure,
  resetAdminLoginFailures
} from '@/lib/adminRateLimit';
import { verifyAndConsumeTotpCode } from '@/lib/totp';
import { appendAdminAudit } from '@/lib/adminAudit';
import { clientKeyFor } from '@/lib/clientIp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' } as const;
const MAX_CODE_LENGTH = 32;

function failureDelay(): Promise<void> {
  const ms = 150 + Math.floor(Math.random() * 150);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {}
): NextResponse {
  return NextResponse.json(
    { error: message, code, ...extra },
    { status, headers: NO_STORE }
  );
}

function field(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export async function POST(request: Request): Promise<NextResponse> {
  const ip = clientKeyFor(request);
  const userAgent = request.headers.get('user-agent') || '';

  // Password changes are session-only. An automation token must not be able to
  // replace the human administrator's credential.
  const auth = authorizeAdminRequest(request, { allowToken: false });
  if (!auth.ok) {
    return jsonError(auth.status, auth.code, auth.message);
  }

  const transport = checkAdminTransport(request);
  if (!transport.ok) {
    appendAdminAudit('password_change_failure', {
      reason: 'insecure_transport',
      ip,
      ua: userAgent
    });
    return jsonError(503, 'ADMIN_HTTPS_REQUIRED', transport.message);
  }

  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  if (contentType.split(';')[0]?.trim() !== 'application/json') {
    return jsonError(415, 'ADMIN_JSON_REQUIRED', 'Content-Type must be application/json');
  }

  const body = await readJsonBodyLimited(request, 4096);
  if (!body.ok) return jsonError(body.status, 'ADMIN_BAD_BODY', body.message);

  const value = body.value && typeof body.value === 'object'
    ? (body.value as Record<string, unknown>)
    : {};
  const currentPassword = field(value.currentPassword);
  const newPassword = field(value.newPassword);
  const code = field(value.code).trim();

  if (!currentPassword) {
    return jsonError(400, 'ADMIN_CURRENT_PASSWORD_REQUIRED', 'Current password is required');
  }
  if (!newPassword) {
    return jsonError(400, 'ADMIN_NEW_PASSWORD_REQUIRED', 'New password is required');
  }
  if (currentPassword.length > 256 || newPassword.length > 256 || code.length > MAX_CODE_LENGTH) {
    return jsonError(400, 'ADMIN_PASSWORD_TOO_LONG', 'One or more fields are too long');
  }
  const passwordPolicy = validateAdminPassword(newPassword);
  if (!passwordPolicy.ok) {
    return jsonError(400, 'ADMIN_PASSWORD_POLICY', passwordPolicy.message);
  }
  if (currentPassword === newPassword) {
    return jsonError(
      400,
      'ADMIN_PASSWORD_UNCHANGED',
      'The new password must be different from the current password'
    );
  }

  const credential = readAdminCredential();
  if (!credential.ok) {
    return jsonError(
      503,
      'ADMIN_UNAVAILABLE',
      'Admin credentials are unavailable or invalid. Check the server log for details.'
    );
  }
  if (credential.source !== 'ADMIN_PASSWORD_FILE') {
    appendAdminAudit('password_change_failure', {
      reason: 'managed_externally',
      source: credential.source,
      ip,
      ua: userAgent
    });
    return jsonError(
      409,
      'ADMIN_PASSWORD_MANAGED_EXTERNALLY',
      'The active password is managed by an environment variable or read-only credential file. ' +
        'Update it through your deployment configuration.'
    );
  }

  // An authenticated session is exempt from the GLOBAL failure ceiling (which a
  // flood from other addresses could otherwise exhaust); the per-client budget
  // still bounds current-password guessing.
  const attempt = consumeAdminLoginAttempt(request, { bypassGlobal: true });
  if (!attempt.ok) {
    appendAdminAudit('password_change_failure', {
      reason: 'rate_limited',
      ip,
      retryAfter: attempt.retryAfter
    });
    return jsonError(429, 'ADMIN_RATE_LIMITED', 'Too many attempts. Try again later.', {
      retryAfter: attempt.retryAfter
    });
  }

  const verified = await verifyPasswordAgainstHash(currentPassword, credential.hash);
  if (!verified.ok) {
    recordAdminLoginFailure();
    appendAdminAudit('password_change_failure', {
      reason: verified.reason,
      ip,
      ua: userAgent
    });
    await failureDelay();
    return jsonError(401, 'ADMIN_BAD_PASSWORD', 'Invalid current password');
  }

  if (credential.totpSecret) {
    if (!code) {
      appendAdminAudit('password_change_failure', {
        reason: 'totp_required',
        ip,
        ua: userAgent
      });
      return jsonError(401, 'ADMIN_TOTP_REQUIRED', 'A TOTP verification code is required', {
        totpRequired: true
      });
    }

    const totp = verifyAndConsumeTotpCode(credential.totpSecret, code);
    if (!totp.ok) {
      recordAdminLoginFailure();
      appendAdminAudit('password_change_failure', {
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

  // If another request rotated the password while scrypt was running, do not
  // silently overwrite that newer credential.
  const latest = readAdminCredential();
  if (!latest.ok || latest.hash !== credential.hash) {
    return jsonError(
      409,
      'ADMIN_PASSWORD_CHANGED',
      'The admin password changed while this request was in progress. Sign in again and retry.'
    );
  }

  let newHash: string;
  try {
    newHash = await createScryptHashAsync(newPassword);
  } catch (error: unknown) {
    console.error('[AdminPassword] Failed to derive new hash:', error);
    return jsonError(503, 'ADMIN_PASSWORD_WRITE_FAILED', 'Unable to create the new password');
  }

  try {
    // No totpSecret argument: preserve existing 2FA enrollment.
    writeAdminCredentialFile(getAdminPasswordFile(), {
      passwordHash: newHash,
      refuseRoot: true
    });
  } catch (error: unknown) {
    console.error('[AdminPassword] Failed to write credential file:', error);
    appendAdminAudit('password_change_failure', {
      reason: 'write_failed',
      ip,
      ua: userAgent
    });
    return jsonError(
      503,
      'ADMIN_PASSWORD_WRITE_FAILED',
      'Unable to write the credential file. Check the data directory permissions.'
    );
  }

  // The password fingerprint changed, so every old session is now invalid. Drop
  // them explicitly and issue a fresh cookie for the administrator who just
  // completed reauthentication.
  destroyAllAdminSessions();
  const session = createAdminSession(passwordFingerprint(newHash));
  resetAdminLoginFailures(attempt.key);

  appendAdminAudit('password_change', {
    ip,
    ua: userAgent,
    totp: credential.totpSecret ? 'enabled' : 'disabled',
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
