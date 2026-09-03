import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function getDatabasePath(): string {
  const dataDbPath = path.join(process.cwd(), 'data', 'courses_db.json');
  const srcDbPath = path.join(process.cwd(), 'src', 'data', 'courses_db.json');

  if (!fs.existsSync(dataDbPath) && fs.existsSync(srcDbPath)) {
    try {
      const dataDir = path.dirname(dataDbPath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      fs.copyFileSync(srcDbPath, dataDbPath);
    } catch (e) {
      console.warn('Failed to initialize data/courses_db.json:', e);
      return srcDbPath;
    }
  }

  return fs.existsSync(dataDbPath) ? dataDbPath : srcDbPath;
}

interface CachedCourses {
  rawJson: string;
  mtimeMs: number;
  etag: string;
}

let memoryCache: CachedCourses | null = null;

export async function GET(request: Request) {
  try {
    const filePath = getDatabasePath();
    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: 'Database file not found' }, { status: 404 });
    }

    const stat = await fs.promises.stat(filePath);
    const mtimeMs = stat.mtimeMs;

    if (!memoryCache || memoryCache.mtimeMs !== mtimeMs) {
      const rawJson = await fs.promises.readFile(filePath, 'utf-8');
      const etag = `W/"${stat.size}-${mtimeMs}"`;
      memoryCache = {
        rawJson,
        mtimeMs,
        etag
      };
    }

    // HTTP 304 Conditional Revalidation
    const clientEtag = request.headers.get('if-none-match');
    if (clientEtag && clientEtag === memoryCache.etag) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          'ETag': memoryCache.etag,
          'Cache-Control': 'public, max-age=60, stale-while-revalidate=300'
        }
      });
    }

    return new NextResponse(memoryCache.rawJson, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'ETag': memoryCache.etag,
        'Cache-Control': 'public, max-age=60, stale-while-revalidate=300'
      }
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
