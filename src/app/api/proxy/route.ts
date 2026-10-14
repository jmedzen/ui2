import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import { Readable } from 'stream';
import { getCacheFilePath, isCached, updateAccessTime, cacheRemoteMedia, fileLooksLikeHtml, invalidateCacheStats, markCacheFileInUse, isDownloadInFlight } from '@/lib/serverMediaCache';
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

/** Upper bound on distinct tracked clients. */
const MAX_PRELOAD_BUCKETS = 5000;

/**
 * Bounds the rate-limit map so it cannot itself become a memory leak.
 *
 * The previous version only pruned *expired* buckets and only once the map had
 * already reached 5000 entries. Within a single 60-second window every bucket is
 * still live, so nothing was evictable and the map grew without limit — an
 * unauthenticated caller could force one allocation per request simply by
 * rotating `X-Forwarded-For`.
 *
 * Expired entries are dropped first; if the map is still full, the entries
 * closest to expiry go too. Shedding load takes precedence over precise
 * accounting, since an attacker rotating keys would otherwise bypass the limit
 * entirely.
 */
function prunePreloadBuckets(now: number) {
  if (preloadBuckets.size < MAX_PRELOAD_BUCKETS) {
    // Opportunistic cheap cleanup while under pressure.
    if (preloadBuckets.size > MAX_PRELOAD_BUCKETS / 2) {
      for (const [key, bucket] of preloadBuckets.entries()) {
        if (now >= bucket.resetAt) preloadBuckets.delete(key);
      }
    }
    return;
  }

  for (const [key, bucket] of preloadBuckets.entries()) {
    if (now >= bucket.resetAt) preloadBuckets.delete(key);
  }
  if (preloadBuckets.size < MAX_PRELOAD_BUCKETS) return;

  // Still full: evict soonest-to-expire entries until we are back under the cap.
  const byExpiry = [...preloadBuckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
  for (const [key] of byExpiry) {
    if (preloadBuckets.size < MAX_PRELOAD_BUCKETS) break;
    preloadBuckets.delete(key);
  }
}

/**
 * Whether `X-Forwarded-For` may be believed.
 *
 * The header is client-controlled unless a reverse proxy overwrites it. Caddy
 * does overwrite it by default, but the app is also published directly on
 * :8410 by compose, so a request reaching that port can name any client it
 * likes and mint a fresh rate-limit bucket per call.
 *
 * Trust is therefore opt-in and explicit: set TRUST_PROXY=1 only when every
 * path into this process passes through a proxy that rewrites the header.
 * The default is off, so an unconfigured deployment fails safe: all callers
 * share one budget rather than each being able to mint their own.
 */
const TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';

function clientKeyFor(request: NextRequest): string {
  if (TRUST_PROXY) {
    const forwarded = request.headers.get('x-forwarded-for');
    const first = (forwarded ? forwarded.split(',')[0].trim() : '');
    if (first) return first;
  }
  // No trustworthy peer identifier is exposed by NextRequest, so fall back to a
  // single shared bucket. This is deliberately conservative: it degrades the
  // limit to "20 preloads per minute for the whole instance" instead of letting
  // a caller escape the limit by inventing a new client address per request.
  return 'local';
}

/**
 * Fixed-window limiter keyed by client address.
 *
 * Note: `x-forwarded-for` is only trustworthy behind a reverse proxy that
 * overwrites it. It is used here as a best-effort bucket key, not as an
 * authorization decision — authorization is handled separately.
 */
function checkPreloadRateLimit(request: NextRequest): boolean {
  const clientKey = clientKeyFor(request);
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
 * Cache-miss download budget
 * ------------------------------------------------------------------ */

/**
 * Upper bound on NEW background downloads started per minute per client.
 *
 * A plain media GET cannot be authorized — it is ordinary playback and every
 * cache miss takes that path — but it must not be an unbounded disk-write
 * primitive either. This budget is charged only when a request actually starts
 * a download, so replaying or scrubbing cached media costs nothing.
 *
 * The default is deliberately generous enough for real browsing (seeking across
 * an album, a lecture series preloading ahead) while still bounding mass abuse.
 */
const CACHE_MISS_WINDOW_MS = 60 * 1000;
const CACHE_MISS_MAX_PER_WINDOW = Math.max(
  1,
  parseInt(process.env.PROXY_CACHE_MISS_MAX_PER_MINUTE || '', 10) || 120
);

const cacheMissBuckets = new Map<string, { count: number; resetAt: number }>();

/** Reuses the preload bucket cap so neither map can grow without bound. */
function pruneCacheMissBuckets(now: number): void {
  for (const [key, bucket] of cacheMissBuckets) {
    if (now >= bucket.resetAt) cacheMissBuckets.delete(key);
  }
  if (cacheMissBuckets.size < MAX_PRELOAD_BUCKETS) return;
  const byExpiry = [...cacheMissBuckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
  for (const [key] of byExpiry) {
    if (cacheMissBuckets.size < MAX_PRELOAD_BUCKETS) break;
    cacheMissBuckets.delete(key);
  }
}

/** Fixed-window limiter for downloads started by an ordinary media GET. */
function checkCacheMissDownloadLimit(request: NextRequest): boolean {
  const clientKey = clientKeyFor(request);
  const now = Date.now();

  pruneCacheMissBuckets(now);

  const bucket = cacheMissBuckets.get(clientKey);
  if (!bucket || now >= bucket.resetAt) {
    cacheMissBuckets.set(clientKey, { count: 1, resetAt: now + CACHE_MISS_WINDOW_MS });
    return true;
  }
  if (bucket.count >= CACHE_MISS_MAX_PER_WINDOW) return false;
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
 * Content types the app renders inline (audio/video players, PDF iframe).
 * Everything else is forced to download rather than render in our origin.
 */
const INLINE_MEDIA_TYPES = ['audio/', 'video/', 'application/pdf', 'application/octet-stream'];

function isInlineMediaType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return INLINE_MEDIA_TYPES.some((prefix) => ct.startsWith(prefix));
}

/**
 * Applies defence-in-depth headers to every proxied response.
 *
 * - `X-Content-Type-Options: nosniff` stops MIME confusion.
 * - Media the app legitimately displays (audio/video/PDF) is served inline so
 *   the players and the PDF iframe keep working. Everything else is forced to
 *   download and gets a locked-down CSP, so it can never render as a document
 *   in this origin.
 * - A CSP `sandbox` is deliberately NOT applied to inline PDFs: it creates a
 *   sandboxed origin that stops the browser's built-in PDF viewer from loading,
 *   which made lecture notes download instead of displaying.
 */
function applySecurityHeaders(headers: Headers, contentType: string, harden = false) {
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');

  const inline = !contentType || isInlineMediaType(contentType);

  if (inline) {
    headers.set('Content-Disposition', 'inline');
  } else {
    // Active content (SVG/XML/HTML lookalikes) never reaches here — those are
    // rejected upstream — but this is the belt-and-braces layer.
    headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
    if (harden) headers.set('Content-Disposition', 'attachment');
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
        void cacheRemoteMedia(targetUrl, cacheFilePath);
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
      //
      // The size guard that used to wrap this (`stat.size < 512`) meant only
      // tiny error pages were detected. An HTML document larger than 512 bytes
      // was served as a HIT forever, while `action=status` — which has no size
      // guard — reported the same file as *not* cached. That disagreement left
      // clients unable to recover. `fileLooksLikeHtml` reads only the first
      // 512 bytes regardless, so the guard bought nothing.
      if (await fileLooksLikeHtml(cacheFilePath)) {
        console.warn(`[Proxy] Discarding HTML-shaped cache entry: ${cacheFilePath}`);
        try {
          await fs.promises.unlink(cacheFilePath);
          invalidateCacheStats();
        } catch {}
      } else {
        const resHeaders = new Headers();
        resHeaders.set('Content-Type', contentType);
        resHeaders.set('Accept-Ranges', 'bytes');
        resHeaders.set('X-Proxy-Cache', 'HIT');
        resHeaders.set('Cache-Control', 'public, max-age=86400, s-maxage=86400');
        applySecurityHeaders(resHeaders, contentType);

        if (parsed === 'unsatisfiable') {
          // Build on the already-hardened `resHeaders` instead of a fresh object.
          // A fresh literal dropped every security header applied just above, so
          // this one response path was unhardened while all its siblings were not.
          resHeaders.set('Content-Range', `bytes */${fileSize}`);
          return new NextResponse(null, { status: 416, headers: resHeaders });
        }

        if (parsed && parsed.kind === 'ok') {
          const { start, end } = parsed;
          const chunksize = end - start + 1;
          const fileStream = fs.createReadStream(cacheFilePath, { start, end });
          // Pin the file against LRU eviction for the lifetime of the stream.
          // Without this an eviction pass could unlink a file mid-playback; an
          // already-open descriptor keeps serving on POSIX, but the next Range
          // request would fail with ENOENT.
          const releaseInUse = markCacheFileInUse(cacheFilePath);
          fileStream.once('close', releaseInUse);
          fileStream.once('error', releaseInUse);

          resHeaders.set('Content-Range', `bytes ${start}-${end}/${fileSize}`);
          resHeaders.set('Content-Length', String(chunksize));

          return new NextResponse(Readable.from(fileStream) as any, {
            status: 206,
            headers: resHeaders
          });
        }

        resHeaders.set('Content-Length', String(fileSize));
        const fileStream = fs.createReadStream(cacheFilePath);
        const releaseInUse = markCacheFileInUse(cacheFilePath);
        fileStream.once('close', releaseInUse);
        fileStream.once('error', releaseInUse);

        return new NextResponse(Readable.from(fileStream) as any, {
          status: 200,
          headers: resHeaders
        });
      }
    }

    // -------------------------------------------------------------
    // CASE 2: CACHE MISS - Proxy to Client & Trigger Formal Disk Cache Download
    // -------------------------------------------------------------
    // The background cache write is a state-changing, disk-consuming action, so
    // it needs the same budget as an explicit preload. It was previously
    // unguarded here — only `action=preload` was limited — so an anonymous
    // caller could drive unbounded disk writes simply by GETing distinct media
    // URLs (25 plain GETs produced zero throttling; 25 preloads produced 15 then
    // 429s).
    //
    // A plain media GET cannot require authorization: it IS normal playback, and
    // every cache miss takes this path. Instead the budget is charged only when
    // this request actually STARTS a new download. Repeats, scrubs and already
    // cached files consume nothing, so legitimate viewing is unaffected while
    // mass distinct-file abuse is bounded.
    const startingNewDownload = !isCached(cacheFilePath) && !isDownloadInFlight(cacheFilePath);
    if (startingNewDownload) {
      if (!checkCacheMissDownloadLimit(request)) {
        // Playback still proceeds; only the background caching is skipped.
        console.warn('[Proxy] Cache-miss download budget exhausted; serving without caching.');
      } else {
        void cacheRemoteMedia(targetUrl, cacheFilePath);
      }
    }

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

    // Do NOT copy the upstream Content-Length.
    //
    // undici advertises `accept-encoding: gzip, deflate` and transparently
    // DECOMPRESSES the body, while the upstream header still describes the
    // COMPRESSED byte count. Forwarding it declared a length the response did
    // not have — a live robots.txt declared 100 bytes and delivered 101 — which
    // truncates or hangs clients and desynchronises keep-alive framing. The
    // runtime sets the correct length for the body it actually sends.
    // Content-Range is still forwarded: it describes the upstream range and is
    // what a 206 response needs, and it is only sent for range requests that the
    // upstream answered without content-coding.
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
