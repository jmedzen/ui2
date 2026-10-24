import { NextResponse } from 'next/server';
import {
  getAdminPasswordFile,
  isAdminTotpEnvConfigured,
  readAdminCredential,
  verifyPasswordAgainstHash,
  writeAdminCredentialFile
} from '@/lib/adminPassword';
import {
  authorizeAdminRequest,
  readJsonBodyLimited
} from '@/lib/adminAuth';
import { checkAdminTransport, destroyOtherAdminSessions } from '@/lib/adminSession';
import {
  consumeAdminLoginAttempt,
  recordAdminLoginFailure,
  resetAdminLoginFailures
} from '@/lib/adminRateLimit';
import {
  buildTotpUri,
  generateTotpSecret,
  parseTotpSecret,
  verifyAndConsumeTotpCode
} from '@/lib/totp';
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

function totpStatus(credential: ReturnType<typeof readAdminCredential>) {
  return {
    ok: true,
    enabled: credential.ok ? Boolean(credential.totpSecret) : false,
    manageable:
      credential.ok &&
      credential.source === 'ADMIN_PASSWORD_FILE' &&
      !isAdminTotpEnvConfigured()
  };
}

/** Reads TOTP management state for an authenticated session. */
export async function GET(request: Request): Promise<NextResponse> {
  const auth = authorizeAdminRequest(request, {
    allowToken: false,
    requireCsrf: false
  });
  if (!auth.ok) return jsonError(auth.status, auth.code, auth.message);

  const credential = readAdminCredential();
  if (!credential.ok) {
    return jsonError(
      503,
      'ADMIN_UNAVAILABLE',
      'Admin credentials are unavailable or invalid. Check the server log for details.'
    );
  }

  return NextResponse.json(totpStatus(credential), { headers: NO_STORE });
}

export async function POST(request: Request): Promise<NextResponse> {
  const ip = clientKeyFor(request);
  const userAgent = request.headers.get('user-agent') || '';

  // TOTP enrollment changes a security credential; automation tokens are not
  // sufficient to do that.
  const auth = authorizeAdminRequest(request, { allowToken: false });
  if (!auth.ok) return jsonError(auth.status, auth.code, auth.message);

  const transport = checkAdminTransport(request);
  if (!transport.ok) {
    appendAdminAudit('totp_failure', {
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

  const action = field(value.action);
  if (action !== 'setup' && action !== 'enable' && action !== 'disable') {
    return jsonError(400, 'ADMIN_TOTP_ACTION_INVALID', 'action must be setup, enable or disable');
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
    return jsonError(
      409,
      'ADMIN_PASSWORD_MANAGED_EXTERNALLY',
      'TOTP enrollment for this deployment is managed outside the UI.'
    );
  }
  if (isAdminTotpEnvConfigured()) {
    return jsonError(
      409,
      'ADMIN_TOTP_MANAGED_EXTERNALLY',
      'ADMIN_TOTP_SECRET is set and overrides the credential file. Update the deployment environment instead.'
    );
  }

  if (action === 'setup') {
    if (credential.totpSecret) {
      return jsonError(
        409,
        'ADMIN_TOTP_ALREADY_ENABLED',
        'TOTP is already enabled. Disable it first if you need to enroll a new device.'
      );
    }

    const secret = generateTotpSecret();
    appendAdminAudit('totp_setup', { ip, ua: userAgent });
    return NextResponse.json(
      {
        ok: true,
        secret,
        otpauthUri: buildTotpUri(secret)
      },
      { headers: NO_STORE }
    );
  }

  const password = field(value.password);
  const code = field(value.code).trim();
  if (!password) {
    return jsonError(400, 'ADMIN_CURRENT_PASSWORD_REQUIRED', 'Current password is required');
  }
  if (password.length > 256 || code.length > MAX_CODE_LENGTH) {
    return jsonError(400, 'ADMIN_TOTP_INPUT_TOO_LONG', 'One or more fields are too long');
  }
  if (!code) {
    return jsonError(401, 'ADMIN_TOTP_REQUIRED', 'A TOTP verification code is required', {
      totpRequired: true
    });
  }

  if (action === 'enable') {
    if (credential.totpSecret) {
      return jsonError(
        409,
        'ADMIN_TOTP_ALREADY_ENABLED',
        'TOTP is already enabled. Disable it first if you need to enroll a new device.'
      );
    }

    const secret = field(value.secret);
    const parsedSecret = parseTotpSecret(secret);
    if (!parsedSecret.ok) {
      return jsonError(400, 'ADMIN_TOTP_SECRET_INVALID', parsedSecret.error);
    }

    const attempt = consumeAdminLoginAttempt(request, { bypassGlobal: true });
    if (!attempt.ok) {
      appendAdminAudit('totp_failure', {
        reason: 'rate_limited',
        action,
        ip,
        retryAfter: attempt.retryAfter
      });
      return jsonError(429, 'ADMIN_RATE_LIMITED', 'Too many attempts. Try again later.', {
        retryAfter: attempt.retryAfter
      });
    }

    const passwordCheck = await checkPassword(password, credential.hash, ip, userAgent, action);
    if (!passwordCheck.ok) return passwordCheck.response;

    const totp = verifyAndConsumeTotpCode(parsedSecret.secret, code);
    if (!totp.ok) {
      recordAdminLoginFailure();
      appendAdminAudit('totp_failure', {
        reason: totp.reason,
        action,
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

    const latest = readAdminCredential();
    if (!latest.ok || latest.hash !== credential.hash || latest.totpSecret) {
      return jsonError(
        409,
        'ADMIN_TOTP_STATE_CHANGED',
        'The admin credential changed while this request was in progress. Refresh and retry.'
      );
    }

    try {
      writeAdminCredentialFile(getAdminPasswordFile(), {
        passwordHash: credential.hash,
        totpSecret: parsedSecret.secret,
        refuseRoot: true
      });
    } catch (error: unknown) {
      console.error('[AdminTOTP] Failed to write credential file:', error);
      appendAdminAudit('totp_failure', { reason: 'write_failed', action, ip, ua: userAgent });
      return jsonError(
        503,
        'ADMIN_TOTP_WRITE_FAILED',
        'Unable to write the credential file. Check the data directory permissions.'
      );
    }

    // Every OTHER session was established with the password alone; it must not
    // outlive the account gaining a second factor. This session just proved
    // both factors, so it is kept.
    destroyOtherAdminSessions(request);
    resetAdminLoginFailures(attempt.key);
    appendAdminAudit('totp_enabled', { ip, ua: userAgent, other_sessions: 'revoked' });
    return NextResponse.json(
      { ok: true, enabled: true, manageable: true },
      { headers: NO_STORE }
    );
  }

  // disable
  if (!credential.totpSecret) {
    return jsonError(409, 'ADMIN_TOTP_NOT_ENABLED', 'TOTP is not currently enabled');
  }

  const attempt = consumeAdminLoginAttempt(request, { bypassGlobal: true });
  if (!attempt.ok) {
    appendAdminAudit('totp_failure', {
      reason: 'rate_limited',
      action,
      ip,
      retryAfter: attempt.retryAfter
    });
    return jsonError(429, 'ADMIN_RATE_LIMITED', 'Too many attempts. Try again later.', {
      retryAfter: attempt.retryAfter
    });
  }

  const passwordCheck = await checkPassword(password, credential.hash, ip, userAgent, action);
  if (!passwordCheck.ok) return passwordCheck.response;

  const totp = verifyAndConsumeTotpCode(credential.totpSecret, code);
  if (!totp.ok) {
    recordAdminLoginFailure();
    appendAdminAudit('totp_failure', {
      reason: totp.reason,
      action,
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

  const latest = readAdminCredential();
  if (!latest.ok || latest.hash !== credential.hash || latest.totpSecret !== credential.totpSecret) {
    return jsonError(
      409,
      'ADMIN_TOTP_STATE_CHANGED',
      'The admin credential changed while this request was in progress. Refresh and retry.'
    );
  }

  try {
    writeAdminCredentialFile(getAdminPasswordFile(), {
      passwordHash: credential.hash,
      totpSecret: null,
      refuseRoot: true
    });
  } catch (error: unknown) {
    console.error('[AdminTOTP] Failed to write credential file:', error);
    appendAdminAudit('totp_failure', { reason: 'write_failed', action, ip, ua: userAgent });
    return jsonError(
      503,
      'ADMIN_TOTP_WRITE_FAILED',
      'Unable to write the credential file. Check the data directory permissions.'
    );
  }

  resetAdminLoginFailures(attempt.key);
  appendAdminAudit('totp_disabled', { ip, ua: userAgent });
  return NextResponse.json(
    { ok: true, enabled: false, manageable: true },
    { headers: NO_STORE }
  );
}

async function checkPassword(
  password: string,
  hash: string,
  ip: string,
  userAgent: string,
  action: string
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const verified = await verifyPasswordAgainstHash(password, hash);
  if (verified.ok) return { ok: true };

  recordAdminLoginFailure();
  appendAdminAudit('totp_failure', {
    reason: verified.reason,
    action,
    ip,
    ua: userAgent
  });
  await failureDelay();
  return {
    ok: false,
    response: jsonError(401, 'ADMIN_BAD_PASSWORD', 'Invalid current password')
  };
}
