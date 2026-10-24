import { NextResponse } from 'next/server';
import fs from 'fs';
import { DATA_CATALOG_FILE, SRC_CATALOG_FILE } from '@/lib/catalogReconcile';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Read-only catalog endpoint.
 *
 * Reconciling the live catalog with the bundled copy used to happen here, on
 * every GET, by course count — so the healthcheck could overwrite a newer scan
 * result with the image's older bundle. That now runs once at boot
 * (lib/catalogReconcile, called from instrumentation.ts) and compares
 * `generated_at`. This route only chooses which file to read.
 */
function getDatabasePath(): string {
  return fs.existsSync(DATA_CATALOG_FILE) ? DATA_CATALOG_FILE : SRC_CATALOG_FILE;
}

/** size + mtime + inode + ctime: a same-length same-mtime replacement still invalidates. */
function signatureOf(st: fs.Stats): string {
  return `${st.size}:${st.mtimeMs}:${st.ino}:${st.ctimeMs}`;
}

interface CachedCourses {
  filePath: string;
  rawJson: string;
  signature: string;
  etag: string;
}

let memoryCache: CachedCourses | null = null;

export async function GET(request: Request) {
  try {
    const filePath = getDatabasePath();
    const exists = fs.existsSync(filePath);
    if (!exists) {
      return NextResponse.json({ error: 'Database file not found' }, { status: 404 });
    }

    const stat = await fs.promises.stat(filePath);
    const signature = signatureOf(stat);

    if (!memoryCache || memoryCache.filePath !== filePath || memoryCache.signature !== signature) {
      const rawJson = await fs.promises.readFile(filePath, 'utf-8');
      const etag = `W/"${stat.size}-${stat.mtimeMs}-${stat.ino}"`;
      memoryCache = { filePath, rawJson, signature, etag };
    }

    // HTTP 304 Conditional Revalidation
    const clientEtag = request.headers.get('if-none-match');
    if (clientEtag && clientEtag === memoryCache.etag) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          'ETag': memoryCache.etag,
          'Cache-Control': 'no-cache, must-revalidate'
        }
      });
    }

    return new NextResponse(memoryCache.rawJson, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'ETag': memoryCache.etag,
        'Cache-Control': 'no-cache, must-revalidate'
      }
    });
  } catch (error: unknown) {
    console.error('[API/Courses] Error:', error);
    return NextResponse.json({ error: 'Failed to load course database' }, { status: 500 });
  }
}
