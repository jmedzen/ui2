import { NextResponse, type NextRequest } from 'next/server';

/**
 * Security headers for HTML documents.
 *
 * `/api/proxy` is deliberately excluded: PDF responses are embedded in a
 * same-origin iframe, so a blanket `frame-ancestors 'none'` / X-Frame-Options
 * header would stop the built-in PDF viewer from rendering lecture notes.
 * API routes set their own resource-specific headers.
 */

const DEVELOPMENT = process.env.NODE_ENV !== 'production';

function contentSecurityPolicy(): string {
  // Next's App Router ships inline bootstrap scripts and React uses inline
  // style attributes in several components. A nonce-based policy would require
  // threading a nonce through the whole app; these origins and the remaining
  // directives still block external script injection, plugins, framing and
  // form exfiltration. The dev-only eval/ws allowances are absent in builds.
  const allowInsecureHttp = process.env.ADMIN_ALLOW_INSECURE_HTTP === '1';
  const scriptSrc = ["'self'", "'unsafe-inline'", ...(DEVELOPMENT ? ["'unsafe-eval'", 'blob:'] : [])];
  const connectSrc = [
    "'self'",
    'https://www.fayun.org',
    'https://fayun.org',
    ...(DEVELOPMENT ? ['ws:', 'wss:'] : [])
  ];

  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob: https://www.fayun.org https://fayun.org",
    `connect-src ${connectSrc.join(' ')}`,
    "worker-src 'self' blob:",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // Upgrading subresources on a deliberately plain-HTTP LAN deployment would
    // request HTTPS on a port that does not speak TLS and break every asset.
    ...(DEVELOPMENT || allowInsecureHttp ? [] : ['upgrade-insecure-requests'])
  ].join('; ');
}

function isApiOrInternal(pathname: string): boolean {
  return (
    pathname.startsWith('/api/') ||
    pathname.startsWith('/_next/') ||
    pathname === '/favicon.ico'
  );
}

export function proxy(request: NextRequest): NextResponse {
  if (isApiOrInternal(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  const response = NextResponse.next();
  response.headers.set('Content-Security-Policy', contentSecurityPolicy());
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
  );
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  return response;
}

export default proxy;

export const config = {
  matcher: [
    /*
     * Run on page documents only. Excluding /api keeps proxied audio, video and
     * PDF responses free of document-level framing rules. _next assets and the
     * favicon do not need these headers and are skipped to avoid overhead.
     */
    '/((?!api|_next/static|_next/image|favicon.ico).*)'
  ]
};
