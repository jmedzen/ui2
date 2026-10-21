import { NextResponse } from 'next/server';

import { authorizeAdminRequest, readJsonBodyLimited } from '@/lib/adminAuth';
import { appendAdminAudit } from '@/lib/adminAudit';
import { checkAdminTransport } from '@/lib/adminSession';
import { clientKeyFor } from '@/lib/clientIp';
import {
  DEFAULT_SITE_URL,
  clearStoredSiteUrl,
  normalizeSiteUrl,
  resolveSiteUrl,
  writeStoredSiteUrl
} from '@/lib/site';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' } as const;

function jsonError(
  status: number,
  code: string,
  message: string
): NextResponse {
  return NextResponse.json({ error: message, code }, { status, headers: NO_STORE });
}

/**
 * Current canonical URL and where it comes from.
 *
 * Readable by any authenticated admin session. The provenance field is what
 * lets the panel explain why a saved value might have no effect: `environment`
 * means SITE_URL is pinned and the form is informational only.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const auth = authorizeAdminRequest(request, { allowToken: false });
  if (!auth.ok) {
    return jsonError(auth.status, auth.code, auth.message);
  }

  const resolved = resolveSiteUrl();
  return NextResponse.json(
    {
      siteUrl: resolved.origin,
      source: resolved.source,
      defaultSiteUrl: DEFAULT_SITE_URL,
      // True when the env var wins, so the UI can disable the input rather
      // than letting the admin save a value that cannot take effect.
      lockedByEnvironment: resolved.source === 'environment'
    },
    { headers: NO_STORE }
  );
}

/**
 * Save or reset the canonical URL.
 *
 * Session-only on purpose: the canonical origin ends up in every page's
 * <link rel="canonical"> and og:url, so a leaked automation token must not be
 * enough to repoint the site's identity at another domain.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const ip = clientKeyFor(request);
  const userAgent = request.headers.get('user-agent') || '';

  const auth = authorizeAdminRequest(request, { allowToken: false });
  if (!auth.ok) {
    return jsonError(auth.status, auth.code, auth.message);
  }

  // Same transport rule as the password endpoint: rewriting the site's public
  // identity over plaintext HTTP would let a network attacker choose it.
  const transport = checkAdminTransport(request);
  if (!transport.ok) {
    appendAdminAudit('site_url_change_failure', {
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

  const value =
    body.value && typeof body.value === 'object'
      ? (body.value as Record<string, unknown>)
      : {};

  if (resolveSiteUrl().source === 'environment') {
    appendAdminAudit('site_url_change_failure', {
      reason: 'managed_externally',
      ip,
      ua: userAgent
    });
    return jsonError(
      409,
      'SITE_URL_MANAGED_EXTERNALLY',
      'SITE_URL is set in the environment, so the stored value would be ignored. Unset it to manage the URL here.'
    );
  }

  // `reset` clears the override and falls back to the built-in default.
  if (value.reset === true) {
    const cleared = clearStoredSiteUrl();
    if (!cleared.ok) {
      return jsonError(500, 'SITE_URL_WRITE_FAILED', 'Could not clear the stored URL.');
    }
    const resolved = resolveSiteUrl();
    appendAdminAudit('site_url_reset', { ip, ua: userAgent, site_url: resolved.origin });
    return NextResponse.json(
      { siteUrl: resolved.origin, source: resolved.source, defaultSiteUrl: DEFAULT_SITE_URL },
      { headers: NO_STORE }
    );
  }

  const candidate = typeof value.siteUrl === 'string' ? value.siteUrl : '';
  const normalized = normalizeSiteUrl(candidate);
  if (!normalized.ok) {
    return jsonError(400, 'SITE_URL_INVALID', normalized.message);
  }

  const written = writeStoredSiteUrl(normalized.value);
  if (!written.ok) {
    // The message is the fs error, which names the path; useful in a container
    // where ./data is a bind mount that may be read-only.
    return jsonError(
      500,
      'SITE_URL_WRITE_FAILED',
      `Could not save the URL (${written.message}). Check that data/ is writable.`
    );
  }

  appendAdminAudit('site_url_change', {
    ip,
    ua: userAgent,
    site_url: normalized.value
  });

  return NextResponse.json(
    { siteUrl: normalized.value, source: 'settings', defaultSiteUrl: DEFAULT_SITE_URL },
    { headers: NO_STORE }
  );
}
