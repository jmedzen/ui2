import { NextRequest, NextResponse } from 'next/server';

const ALLOWED_HOSTS = ['www.fayun.org', 'fayun.org'];

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    let url = searchParams.get('url');
    let path = searchParams.get('path');

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

    const reqHeaders: HeadersInit = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://www.fayun.org/',
      'Accept': '*/*'
    };

    const range = request.headers.get('range');
    if (range) {
      reqHeaders['Range'] = range;
    }

    const response = await fetch(targetUrl, {
      headers: reqHeaders,
      cache: 'no-cache'
    });

    if (!response.ok && response.status !== 206) {
      return new NextResponse(`Remote asset returned ${response.status}: ${response.statusText}`, { status: response.status });
    }

    const pathOrUrl = path || url || '';
    const ext = pathOrUrl.split('?')[0].split('.').pop()?.toLowerCase() || '';

    let contentType = response.headers.get('content-type') || '';

    // Determine correct MIME type if missing or generic octet-stream
    if (!contentType || contentType.includes('text/html') || contentType.includes('application/octet-stream')) {
      if (['mp3'].includes(ext)) contentType = 'audio/mpeg';
      else if (['m4a', 'aac'].includes(ext)) contentType = 'audio/mp4';
      else if (['ogg'].includes(ext)) contentType = 'audio/ogg';
      else if (['wav'].includes(ext)) contentType = 'audio/wav';
      else if (['mp4', 'm4v', 'mov'].includes(ext)) contentType = 'video/mp4';
      else if (['webm'].includes(ext)) contentType = 'video/webm';
      else if (['pdf'].includes(ext)) contentType = 'application/pdf';
      else contentType = 'audio/mpeg';
    }

    const resHeaders = new Headers();
    resHeaders.set('Content-Type', contentType);
    resHeaders.set('X-Content-Type-Options', 'nosniff');
    resHeaders.set('Referrer-Policy', 'strict-origin-when-cross-origin');
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
