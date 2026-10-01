import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const DATA_FILE = path.join(/*turbopackIgnore: true*/ process.cwd(), 'data', 'courses_db.json');
const SRC_FILE = path.join(/*turbopackIgnore: true*/ process.cwd(), 'src', 'data', 'courses_db.json');

function getDatabasePath(): string {
  try {
    if (fs.existsSync(SRC_FILE)) {
      if (!fs.existsSync(DATA_FILE)) {
        const dataDir = path.dirname(DATA_FILE);
        if (!fs.existsSync(dataDir)) {
          fs.mkdirSync(dataDir, { recursive: true });
        }
        fs.copyFileSync(SRC_FILE, DATA_FILE);
        return DATA_FILE;
      }

      // If DATA_FILE already exists, check if it is outdated compared to bundled SRC_FILE
      try {
        const dataRaw = fs.readFileSync(DATA_FILE, 'utf-8');
        const srcRaw = fs.readFileSync(SRC_FILE, 'utf-8');
        const dataContent = JSON.parse(dataRaw);
        const srcContent = JSON.parse(srcRaw);
        const dataTotal = Number(dataContent.total_courses || dataContent.courses?.length || 0);
        const srcTotal = Number(srcContent.total_courses || srcContent.courses?.length || 0);

        // If bundled SRC has more courses than the host data file, upgrade host data file!
        if (srcTotal > dataTotal) {
          console.log(`[Database] Auto-upgrading data/courses_db.json (${dataTotal} -> ${srcTotal} courses) from bundled image.`);
          // Preserve any auto_healed stats
          if (dataContent.last_auto_healed_at) {
            srcContent.last_auto_healed_at = dataContent.last_auto_healed_at;
          }
          if (dataContent.total_repaired_courses) {
            srcContent.total_repaired_courses = dataContent.total_repaired_courses;
          }
          fs.writeFileSync(DATA_FILE, JSON.stringify(srcContent, null, 2), 'utf-8');
        }
      } catch (parseErr) {
        console.warn('Failed to compare database versions:', parseErr);
      }
    }
  } catch (e) {
    console.warn('Failed to verify data/courses_db.json:', e);
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
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
