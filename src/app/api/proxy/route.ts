import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import { Readable } from 'stream';
import { getCacheFilePath, isCached, updateAccessTime, cacheRemoteMedia } from '@/lib/serverMediaCache';

const ALLOWED_HOSTS = ['www.fayun.org', 'fayun.org'];

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    let url = searchParams.get('url');
    let path = searchParams.get('path');
    const action = searchParams.get('action');

    let targetUrl = '';
    if (url) {
      // Validate SSRF: URL must belong to allowed fayun.org host
      try {
        const parsed = new URL(url);
        if (!ALLOWED_HOSTS.includes(parsed.hostname.toLowerCase())) {
          return new NextResponse('Forbidden: Proxying to external domains is strictly prohibited.', { status: 403 });
        }
        targetUrl = parsed.toString();
      } catch {
        return new NextResponse('Invalid target URL format', { status: 400 });
      }
    } else if (path) {
      // Sanitize path against directory traversal
      if (path.includes('..')) {
        return new NextResponse('Forbidden: Invalid path sequence', { status: 400 });
      }
      const cleanPath = path.startsWith('/') ? path : `/${path}`;
      targetUrl = `https://www.fayun.org/ftpadmin${encodeURI(cleanPath)}`;
    } else {
      return new NextResponse('Missing url or path parameter', { status: 400 });
    }

    const pathOrUrl = path || url || '';
    const ext = pathOrUrl.split('?')[0].split('.').pop()?.toLowerCase() || '';

    const cacheFilePath = getCacheFilePath(targetUrl, ext);
    const reqHeaders: HeadersInit = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://www.fayun.org/',
      'Accept': '*/*'
    };

    // Action: Preload background cache without blocking client
    if (action === 'preload') {
      if (!isCached(cacheFilePath)) {
        cacheRemoteMedia(targetUrl, cacheFilePath, reqHeaders);
      }
      return NextResponse.json({ status: 'preloading', targetUrl });
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
      const range = request.headers.get('range');

      const resHeaders = new Headers();
      resHeaders.set('Content-Type', contentType);
      resHeaders.set('Accept-Ranges', 'bytes');
      resHeaders.set('X-Proxy-Cache', 'HIT');
      resHeaders.set('Cache-Control', 'public, max-age=86400, s-maxage=86400');

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

        if (start >= fileSize || end >= fileSize) {
          return new NextResponse(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${fileSize}` }
          });
        }

        const chunksize = end - start + 1;
        const fileStream = fs.createReadStream(cacheFilePath, { start, end });

        resHeaders.set('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        resHeaders.set('Content-Length', String(chunksize));

        return new NextResponse(Readable.from(fileStream) as any, {
          status: 206,
          headers: resHeaders
        });
      } else {
        resHeaders.set('Content-Length', String(fileSize));
        const fileStream = fs.createReadStream(cacheFilePath);

        return new NextResponse(Readable.from(fileStream) as any, {
          status: 200,
          headers: resHeaders
        });
      }
    }

    // -------------------------------------------------------------
    // CASE 2: CACHE MISS - Stream from Remote & Cache in Background
    // -------------------------------------------------------------
    const range = request.headers.get('range');
    if (range) {
      reqHeaders['Range'] = range;
    }

    // Always trigger background full download & 15GB LRU cache check for requested files
    cacheRemoteMedia(targetUrl, cacheFilePath, reqHeaders);

    const response = await fetch(targetUrl, {
      headers: reqHeaders,
      cache: 'no-cache'
    });

    if (!response.ok && response.status !== 206) {
      return new NextResponse(`Remote asset returned ${response.status}: ${response.statusText}`, { status: response.status });
    }

    const rawContentType = (response.headers.get('content-type') || '').toLowerCase();
    if (rawContentType.includes('text/html')) {
      return new NextResponse('Remote asset not found (Returned HTML SPA Page)', { status: 404 });
    }

    const resHeaders = new Headers();
    resHeaders.set('Content-Type', rawContentType || contentType);
    resHeaders.set('X-Content-Type-Options', 'nosniff');
    resHeaders.set('X-Proxy-Cache', 'MISS');
    resHeaders.set('Cache-Control', 'public, max-age=86400, s-maxage=86400');

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
  } catch (error: any) {
    return new NextResponse(`Proxy error: ${error.message}`, { status: 500 });
  }
}
