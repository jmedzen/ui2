import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const DATA_FILE = path.join(/*turbopackIgnore: true*/ process.cwd(), 'data', 'courses_db.json');
const SRC_FILE = path.join(/*turbopackIgnore: true*/ process.cwd(), 'src', 'data', 'courses_db.json');

function getDatabasePath(): string {
  if (!fs.existsSync(DATA_FILE) && fs.existsSync(SRC_FILE)) {
    try {
      const dataDir = path.join(/*turbopackIgnore: true*/ process.cwd(), 'data');
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      fs.copyFileSync(SRC_FILE, DATA_FILE);
    } catch (e) {
      console.warn('Failed to initialize data/courses_db.json:', e);
      return SRC_FILE;
    }
  }

  return fs.existsSync(DATA_FILE) ? DATA_FILE : SRC_FILE;
}

interface CachedCourses {
  filePath: string;
  rawJson: string;
  mtimeMs: number;
  etag: string;
}

let memoryCache: CachedCourses | null = null;

export async function GET(request: Request) {
  try {
    const filePath = getDatabasePath();
    const isData = filePath === DATA_FILE;
    const exists = isData ? fs.existsSync(DATA_FILE) : fs.existsSync(SRC_FILE);
    if (!exists) {
      return NextResponse.json({ error: 'Database file not found' }, { status: 404 });
    }

    const stat = isData
      ? await fs.promises.stat(DATA_FILE)
      : await fs.promises.stat(SRC_FILE);
    const mtimeMs = stat.mtimeMs;

    if (!memoryCache || memoryCache.filePath !== filePath || memoryCache.mtimeMs !== mtimeMs) {
      const rawJson = filePath === DATA_FILE 
        ? await fs.promises.readFile(DATA_FILE, 'utf-8')
        : await fs.promises.readFile(SRC_FILE, 'utf-8');
      const etag = `W/"${stat.size}-${mtimeMs}"`;
      memoryCache = {
        filePath,
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
