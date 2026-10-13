import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import { Readable } from 'stream';
import { getCacheFilePath, isCached, updateAccessTime, cacheRemoteMedia, fileLooksLikeHtml } from '@/lib/serverMediaCache';
import { authorizeTaskRequest } from '@/lib/serverTasks';

const ALLOWED_HOSTS = ['www.fayun.org', 'fayun.org'];
const ALLOWED_PROTOCOLS = ['https:'];

/* ------------------------------------------------------------------ *
 * S1: rate limiting for the expensive `preload` action
 * ------------------------------------------------------------------ */

/**
 * `action=preload` causes the server to download and persist a whole remote
 * file. It is the cheapest way for an anonymous caller to consume server disk,
 * bandwidth and I/O, so it gets both an auth check and a per-client budget.
 */
const PRELOAD_WINDOW_MS = 60 * 1000;
const PRELOAD_MAX_PER_WINDOW = Math.max(
  1,
  parseInt(process.env.PROXY_PRELOAD_MAX_PER_MINUTE || '', 10) || 20
);

const preloadBuckets = new Map<string, { count: number; resetAt: number }>();

/** Bounds the rate-limit map so it cannot itself become a memory leak. */
function prunePreloadBuckets(now: number) {
  if (preloadBuckets.size < 5000) return;
  for (const [key, bucket] of preloadBuckets.entries()) {
    if (now >= bucket.resetAt) preloadBuckets.delete(key);
  }
}

/**
 * Fixed-window limiter keyed by client address.
 *
 * Note: `x-forwarded-for` is only trustworthy behind a reverse proxy that
 * overwrites it. It is used here as a best-effort bucket key, not as an
 * authorization decision — authorization is handled separately.
 */
function checkPreloadRateLimit(request: NextRequest): boolean {
  const forwarded = request.headers.get('x-forwarded-for');
  const clientKey = (forwarded ? forwarded.split(',')[0].trim() : '') || 'local';
  const now = Date.now();

  prunePreloadBuckets(now);

  const bucket = preloadBuckets.get(clientKey);
  if (!bucket || now >= bucket.resetAt) {
    preloadBuckets.set(clientKey, { count: 1, resetAt: now + PRELOAD_WINDOW_MS });
    return true;
  }
  if (bucket.count >= PRELOAD_MAX_PER_WINDOW) return false;
  bucket.count++;
  return true;
}

/* ------------------------------------------------------------------ *
 * S3: response hardening
 * ------------------------------------------------------------------ */

/**
 * Content types that a browser may render as an active document in our origin.
 * Blocking only `text/html` left SVG/XML able to execute script in the app's
 * origin when opened directly.
 */
function isActiveDocumentType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return (
    ct.includes('text/html') ||
    ct.includes('application/xhtml') ||
    ct.includes('image/svg') ||
    ct.includes('text/xml') ||
    ct.includes('application/xml')
  );
}

/**
 * Applies defence-in-depth headers to every proxied response.
 *
 * - `X-Content-Type-Options: nosniff` stops MIME confusion.
 * - A locked-down CSP neutralises any active content that slips through.
 * - Media is forced to download rather than render in this origin.
 */
function applySecurityHeaders(headers: Headers, contentType: string, asAttachment = false) {
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  if (asAttachment && contentType && !contentType.startsWith('audio/') && !contentType.startsWith('video/')) {
    headers.set('Content-Disposition', 'attachment');
  }
}

/**
 * Decodes one query-parameter layer without ever throwing.
 *
 * A bare "%" (common in real fayun.org filenames such as "100%講記") makes
 * `decodeURIComponent` raise URIError. That used to surface as an opaque HTTP
 * 500 from the outer catch; returning the raw value instead lets the request
 * proceed and the origin decide.
 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Reverses one layer of /api/proxy wrapping.
 *
 * The value is parsed as a real query string rather than split on the first
 * "&", because legitimate media paths may themselves contain an ampersand
 * (e.g. "Master's Teaching & Glossary"). Splitting blindly truncated the path
 * at the "&", producing a 404 against the wrong file.
 */
function unwrapProxyValue(value: string): string {
  if (!value) return '';
  const marker = '/api/proxy?';
  const idx = value.indexOf(marker);
  if (idx === -1) return value;

  const query = value.slice(idx + marker.length);
  const params = new URLSearchParams(query);
  const inner = params.get('path') ?? params.get('url');
  if (inner === null) return value;
  return safeDecode(inner);
}

function sanitizePath(rawPath: string): string {
  if (!rawPath) return '';
  // Peel off nested proxy wrappers (bounded to avoid pathological input).
  let cleaned = rawPath;
  for (let i = 0; i < 8; i++) {
    const next = unwrapProxyValue(cleaned);
    if (next === cleaned) break;
    cleaned = next;
  }
  return cleaned;
}

interface ParsedRange {
  kind: 'ok' | 'unsatisfiable';
  start: number;
  end: number;
}

/**
 * Parses a single-range `bytes=` header, including the suffix form (`bytes=-N`)
 * which browsers use to sniff trailing metadata.
 *
 * Returns null for absent/unparseable/multi-range headers so the caller can fall
 * back to a plain 200, and `unsatisfiable` when the range lies outside the file.
 * The previous implementation treated `bytes=-1000` as `0-1000` (returning the
 * *first* bytes instead of the last) and crashed with a 500 on inverted ranges
 * like `bytes=100-50`.
 */
function parseSingleRange(header: string | null, fileSize: number): ParsedRange | 'unsatisfiable' | null {
  if (!header) return null;
  const match = /^bytes=(.*)$/i.exec(header.trim());
  if (!match) return null;

  const spec = match[1].trim();
  // Multi-range requests are not supported; serve the whole entity instead.
  if (spec.includes(',')) return null;

  const parts = spec.split('-');
  if (parts.length !== 2) return null;

  const [rawStart, rawEnd] = parts;
  const startStr = rawStart.trim();
  const endStr = rawEnd.trim();

  if (startStr === '' && endStr === '') return null;

  // Suffix form: bytes=-N => last N bytes.
  if (startStr === '') {
    const suffixLength = parseInt(endStr, 10);
    if (!Number.isFinite(suffixLength)) return null;
    if (suffixLength <= 0) return 'unsatisfiable';
    if (fileSize === 0) return 'unsatisfiable';
    const start = Math.max(0, fileSize - suffixLength);
    return { kind: 'ok', start, end: fileSize - 1 };
  }

  const start = parseInt(startStr, 10);
  if (!Number.isFinite(start)) return null;
  if (start < 0) return null;
  if (start >= fileSize) return 'unsatisfiable';

  let end: number;
  if (endStr === '') {
    end = fileSize - 1;
  } else {
    const parsedEnd = parseInt(endStr, 10);
    if (!Number.isFinite(parsedEnd)) return null;
    // Inverted ranges are invalid; fall back to a full response.
    if (parsedEnd < start) return null;
    end = Math.min(parsedEnd, fileSize - 1);
  }

  return { kind: 'ok', start, end };
}

export async function GET(request: NextRequest) {
  let cacheFilePathForLog = '';
  try {
    const searchParams = request.nextUrl.searchParams;
    const url = searchParams.get('url');
    const rawPath = searchParams.get('path');
    const action = searchParams.get('action');

    let targetUrl = '';
    if (url) {
      const cleanUrl = sanitizePath(url);
      try {
        const parsed = new URL(cleanUrl);
        if (!ALLOWED_HOSTS.includes(parsed.hostname.toLowerCase())) {
          return new NextResponse('Forbidden: Proxying to external domains is strictly prohibited.', { status: 403 });
        }
        // S2: pin the protocol and port. The hostname allowlist alone accepted
        // any port, turning the proxy into a probe for non-HTTP services on the
        // upstream host (e.g. :22, :6379, :9200).
        if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
          return new NextResponse('Forbidden: Only HTTPS upstreams are permitted.', { status: 403 });
        }
        const port = parsed.port || '443';
        if (port !== '443') {
          return new NextResponse('Forbidden: Non-standard upstream ports are prohibited.', { status: 403 });
        }
        targetUrl = parsed.toString();
      } catch {
        return new NextResponse('Invalid target URL format', { status: 400 });
      }
    } else if (rawPath) {
      const cleanPath = sanitizePath(rawPath);
      if (cleanPath.includes('..')) {
        return new NextResponse('Forbidden: Invalid path sequence', { status: 400 });
      }
      const formattedPath = cleanPath.startsWith('/') ? cleanPath : `/${cleanPath}`;
      targetUrl = `https://www.fayun.org/ftpadmin${encodeURI(formattedPath)}`;
    } else {
      return new NextResponse('Missing url or path parameter', { status: 400 });
    }

    // Extract file extension cleanly without query strings
    const urlObj = new URL(targetUrl);
    const pathname = urlObj.pathname;
    const ext = pathname.split('.').pop()?.toLowerCase() || '';

    const cacheFilePath = getCacheFilePath(targetUrl, ext);
    cacheFilePathForLog = cacheFilePath;
    const reqHeaders: HeadersInit = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://www.fayun.org/',
      'Accept': '*/*'
    };

    // Action: Status check endpoint
    if (action === 'status') {
      let cached = isCached(cacheFilePath);
      // A poisoned entry (an HTML error page stored under a media name) reports
      // as *not* cached so the client stops preferring the broken local copy.
      if (cached && (await fileLooksLikeHtml(cacheFilePath))) {
        cached = false;
      }
      let size = 0;
      if (cached) {
        try {
          size = fs.statSync(cacheFilePath).size;
        } catch {}
      }
      return NextResponse.json({
        isCached: cached,
        size,
        targetUrl
      }, {
        headers: { 'Cache-Control': 'no-store' }
      });
    }

    // Action: Preload background cache without blocking client
    //
    // S1: this makes the server fetch and persist an arbitrary remote file, so it
    // is an expensive, state-changing action. It requires same-origin/token
    // authorization and a per-client rate limit; otherwise anyone could drive
    // unbounded disk writes using the media paths published by /api/courses.
    if (action === 'preload') {
      const auth = authorizeTaskRequest(request);
      if (!auth.ok) {
        return NextResponse.json({ error: auth.message }, { status: auth.status });
      }
      if (!checkPreloadRateLimit(request)) {
        return NextResponse.json(
          { error: 'Too many preload requests, please slow down' },
          { status: 429, headers: { 'Retry-After': '60' } }
        );
      }
      if (!isCached(cacheFilePath)) {
        void cacheRemoteMedia(targetUrl, cacheFilePath, reqHeaders);
      }
      return NextResponse.json({ status: 'preloading' }, {
        headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }
      });
    }

    // Action: Probe/speed test response
    if (action === 'probe') {
      return new NextResponse('probe-ok', {
        headers: {
          'Cache-Control': 'no-store',
          'X-Proxy-Speed-Probe': '1'
        }
      });
    }

    // Determine correct MIME type
    let contentType = '';
    if (['mp3'].includes(ext)) contentType = 'audio/mpeg';
    else if (['m4a', 'aac'].includes(ext)) contentType = 'audio/mp4';
    else if (['ogg'].includes(ext)) contentType = 'audio/ogg';
    else if (['wav'].includes(ext)) contentType = 'audio/wav';
    else if (['mp4', 'm4v', 'mov'].includes(ext)) contentType = 'video/mp4';
    else if (['webm'].includes(ext)) contentType = 'video/webm';
    else if (['pdf'].includes(ext)) contentType = 'application/pdf';
    else contentType = 'audio/mpeg';

    // -------------------------------------------------------------
    // CASE 1: CACHE HIT - Serve directly from Server Disk
    // -------------------------------------------------------------
    if (isCached(cacheFilePath)) {
      updateAccessTime(cacheFilePath);

      const stat = fs.statSync(cacheFilePath);
      const fileSize = stat.size;
      const rangeHeader = request.headers.get('range');
      const parsed = parseSingleRange(rangeHeader, fileSize);

      // Corrupt entry: evict and fall through to the live proxy path.
      if (stat.size > 0 && stat.size < 512 && (await fileLooksLikeHtml(cacheFilePath))) {
        console.warn(`[Proxy] Discarding HTML-shaped cache entry: ${cacheFilePath}`);
        try {
          await fs.promises.unlink(cacheFilePath);
        } catch {}
      } else {
        const resHeaders = new Headers();
        resHeaders.set('Content-Type', contentType);
        resHeaders.set('Accept-Ranges', 'bytes');
        resHeaders.set('X-Proxy-Cache', 'HIT');
        resHeaders.set('Cache-Control', 'public, max-age=86400, s-maxage=86400');
        applySecurityHeaders(resHeaders, contentType);

        if (parsed === 'unsatisfiable') {
          return new NextResponse(null, {
            status: 416,
            headers: {
              'Content-Range': `bytes */${fileSize}`,
              'Accept-Ranges': 'bytes'
            }
          });
        }

        if (parsed && parsed.kind === 'ok') {
          const { start, end } = parsed;
          const chunksize = end - start + 1;
          const fileStream = fs.createReadStream(cacheFilePath, { start, end });

          resHeaders.set('Content-Range', `bytes ${start}-${end}/${fileSize}`);
          resHeaders.set('Content-Length', String(chunksize));

          return new NextResponse(Readable.from(fileStream) as any, {
            status: 206,
            headers: resHeaders
          });
        }

        resHeaders.set('Content-Length', String(fileSize));
        const fileStream = fs.createReadStream(cacheFilePath);

        return new NextResponse(Readable.from(fileStream) as any, {
          status: 200,
          headers: resHeaders
        });
      }
    }

    // -------------------------------------------------------------
    // CASE 2: CACHE MISS - Proxy to Client & Trigger Formal Disk Cache Download
    // -------------------------------------------------------------
    // Trigger background download of full formal file (.mp4 / .mp3 / .pdf)
    void cacheRemoteMedia(targetUrl, cacheFilePath);

    const range = request.headers.get('range');
    if (range) {
      reqHeaders['Range'] = range;
    }

    const response = await fetch(targetUrl, {
      headers: reqHeaders,
      cache: 'no-store'
    });

    if (!response.ok && response.status !== 206) {
      return new NextResponse(`Remote asset returned ${response.status}: ${response.statusText}`, { status: response.status });
    }

    const rawContentType = (response.headers.get('content-type') || '').toLowerCase();
    // S3: block every active-document type, not just text/html. SVG and XML can
    // execute script when navigated to and this response shares the app origin.
    if (isActiveDocumentType(rawContentType)) {
      return new NextResponse('Remote asset not found (Returned active document)', { status: 404 });
    }

    const resHeaders = new Headers();
    const effectiveType = rawContentType || contentType;
    if (rawContentType) {
      resHeaders.set('Content-Type', rawContentType);
    }
    resHeaders.set('X-Proxy-Cache', 'MISS');
    resHeaders.set('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    // Force anything that is not audio/video to download rather than render.
    applySecurityHeaders(resHeaders, effectiveType, true);

    if (response.headers.get('content-length')) {
      resHeaders.set('Content-Length', response.headers.get('content-length')!);
    }
    if (response.headers.get('content-range')) {
      resHeaders.set('Content-Range', response.headers.get('content-range')!);
    }
    if (response.headers.get('accept-ranges')) {
      resHeaders.set('Accept-Ranges', response.headers.get('accept-ranges')!);
    }

    return new NextResponse(response.body as any, {
      status: response.status,
      headers: resHeaders
    });
  } catch (error: unknown) {
    // Do not echo internal error strings back to the client.
    console.error(`[Proxy] Unhandled error for ${cacheFilePathForLog || '(unknown target)'}:`, error);
    return new NextResponse('Proxy error: upstream request failed', { status: 502 });
  }
}
