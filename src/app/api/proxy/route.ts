import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { getCacheFilePath, isCached, updateAccessTime, enforceLRULimit, cacheRemoteMedia } from '@/lib/serverMediaCache';

const ALLOWED_HOSTS = ['www.fayun.org', 'fayun.org'];

function sanitizePath(rawPath: string): string {
  if (!rawPath) return '';
  let cleaned = rawPath;
  if (cleaned.includes('/api/proxy?path=')) {
    cleaned = cleaned.split('/api/proxy?path=')[1];
  }
  if (cleaned.includes('/api/proxy?url=')) {
    cleaned = cleaned.split('/api/proxy?url=')[1];
  }
  cleaned = decodeURIComponent(cleaned.split('&')[0]);
  return cleaned;
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    let url = searchParams.get('url');
    let rawPath = searchParams.get('path');
    const action = searchParams.get('action');

    let targetUrl = '';
    if (url) {
      const cleanUrl = sanitizePath(url);
      try {
        const parsed = new URL(cleanUrl);
        if (!ALLOWED_HOSTS.includes(parsed.hostname.toLowerCase())) {
          return new NextResponse('Forbidden: Proxying to external domains is strictly prohibited.', { status: 403 });
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
    // CASE 2: CACHE MISS - Stream Teeing (Instant Play + Disk Cache)
    // -------------------------------------------------------------
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

    // If no stream body, fallback to response
    if (!response.body) {
      return new NextResponse(null, { status: response.status, headers: resHeaders });
    }

    // Tee the Web Stream into 2 branches:
    // Branch 1 -> Immediate response to client for 0-wait instant playback
    // Branch 2 -> Synchronously pipe into local disk cache .tmp file
    const [streamForClient, streamForDisk] = response.body.tee();

    // Background disk cache writer (non-blocking)
    (async () => {
      const tempPath = `${cacheFilePath}.tmp`;
      try {
        if (!fs.existsSync(cacheFilePath) && !fs.existsSync(tempPath)) {
          const fileStream = fs.createWriteStream(tempPath);
          const nodeStream = Readable.fromWeb(streamForDisk as any);

          nodeStream.pipe(fileStream);

          await new Promise<void>((resolve, reject) => {
            fileStream.on('finish', () => resolve());
            fileStream.on('error', (err) => reject(err));
            nodeStream.on('error', (err) => reject(err));
          });

          await fs.promises.rename(tempPath, cacheFilePath);
          updateAccessTime(cacheFilePath);
          console.log(`[Media Cache Tee] Successfully cached file: ${path.basename(cacheFilePath)}`);
          enforceLRULimit();
        }
      } catch (err) {
        console.warn(`[Media Cache Tee] Background stream save error:`, err);
        try {
          if (fs.existsSync(tempPath)) await fs.promises.unlink(tempPath);
        } catch {}
      }
    })();

    return new NextResponse(streamForClient as any, {
      status: response.status,
      headers: resHeaders
    });
  } catch (error: any) {
    return new NextResponse(`Proxy error: ${error.message}`, { status: 500 });
  }
}
