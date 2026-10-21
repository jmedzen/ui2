import { NextResponse } from 'next/server';
import { checkAdminCsrf } from '@/lib/adminAuth';
import {
  ADMIN_SESSION_COOKIE,
  destroyAdminSession,
  readCookie,
  serializeClearAdminSessionCookie
} from '@/lib/adminSession';
import { appendAdminAudit } from '@/lib/adminAudit';
import { clientKeyFor } from '@/lib/clientIp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' } as const;

/**
 * Destroys the current admin session.
 *
 * Logout is idempotent: an expired or already-removed session still gets a
 * clearing cookie, so a stale browser tab cannot keep presenting dead state.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!checkAdminCsrf(request)) {
    return NextResponse.json(
      { error: 'Request rejected: missing or invalid CSRF/origin headers', code: 'ADMIN_CSRF_REJECTED' },
      { status: 403, headers: NO_STORE }
    );
  }

  const hadCookie = Boolean(readCookie(request, ADMIN_SESSION_COOKIE));
  destroyAdminSession(request);

  appendAdminAudit('logout', {
    ip: clientKeyFor(request),
    hadSession: hadCookie ? 'yes' : 'no'
  });

  return NextResponse.json(
    { ok: true },
    {
      headers: {
        ...NO_STORE,
        'Set-Cookie': serializeClearAdminSessionCookie(request)
      }
    }
  );
}
