import { NextResponse } from 'next/server';
import { getAdminAuthStatus } from '@/lib/adminAuth';
import {
  ADMIN_SESSION_COOKIE,
  readCookie,
  serializeClearAdminSessionCookie
} from '@/lib/adminSession';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' } as const;

/**
 * Session status for the admin UI.
 *
 * This endpoint intentionally stays cheap and non-secret: it reports whether a
 * password is configured and whether the current cookie maps to a live session.
 * It never returns the hash, the automation token, or the credential file path.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const status = getAdminAuthStatus(request);

  const headers: Record<string, string> = { ...NO_STORE };
  // If the browser presented a dead/rotated session cookie, clear it now rather
  // than waiting for the next failed admin action.
  if (!status.authenticated && readCookie(request, ADMIN_SESSION_COOKIE)) {
    headers['Set-Cookie'] = serializeClearAdminSessionCookie(request);
  }

  return NextResponse.json(status, { headers });
}
