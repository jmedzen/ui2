import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const DATA_FILE = path.join(/*turbopackIgnore: true*/ process.cwd(), 'data', 'courses_db.json');
const SRC_FILE = path.join(/*turbopackIgnore: true*/ process.cwd(), 'src', 'data', 'courses_db.json');

/**
 * Result of the last database-version reconciliation, keyed by the mtimes and
 * sizes of both candidate files. Without this memo every request re-read and
 * re-parsed two ~900 KB JSON documents just to decide whether an upgrade was
 * needed — and the compose healthcheck polls this route every 30 seconds.
 */
interface ReconcileResult {
  signature: string;
  dbPath: string;
}

let reconcileCache: ReconcileResult | null = null;

function statSignature(): string {
  const parts: string[] = [];
  for (const file of [DATA_FILE, SRC_FILE]) {
    try {
      const st = fs.statSync(file);
      parts.push(`${st.size}:${st.mtimeMs}`);
    } catch {
      parts.push('missing');
    }
  }
  return parts.join('|');
}

function getDatabasePath(): string {
  const signature = statSignature();
  if (reconcileCache && reconcileCache.signature === signature) {
    return reconcileCache.dbPath;
  }

  let resolved = fs.existsSync(DATA_FILE) ? DATA_FILE : SRC_FILE;

  try {
    if (fs.existsSync(SRC_FILE) && fs.existsSync(DATA_FILE)) {
      const dataRaw = fs.readFileSync(DATA_FILE, 'utf-8');
      const srcRaw = fs.readFileSync(SRC_FILE, 'utf-8');
      const dataContent = JSON.parse(dataRaw);
      const srcContent = JSON.parse(srcRaw);
      const dataTotal = Number(dataContent.total_courses || dataContent.courses?.length || 0);
      const srcTotal = Number(srcContent.total_courses || srcContent.courses?.length || 0);

      // If bundled SRC has more courses than the host data file, upgrade host data file!
      //
      // Guarded: the bundled file is only trusted when it is structurally sound.
      // "More courses" alone is not evidence of a better catalog -- a truncated
      // or half-written src file can report a larger count while carrying no
      // usable rows, and this path would then replace a good host catalog with
      // it (only two bookkeeping fields were preserved).
      const dataCourses = Array.isArray(dataContent.courses) ? dataContent.courses : null;
      const srcCourses = Array.isArray(srcContent.courses) ? srcContent.courses : null;
      const srcUsable =
        srcCourses !== null &&
        srcCourses.length > 0 &&
        srcCourses.every((c: unknown) => c && typeof c === 'object' && (c as { id?: unknown }).id != null);

      if (srcTotal > dataTotal && srcUsable && dataCourses !== null) {
        console.log(`[Database] Auto-upgrading data/courses_db.json (${dataTotal} -> ${srcTotal} courses) from bundled image.`);
        // Preserve every bookkeeping field the host file owns, not just two:
        // anything the bundled copy cannot know about would otherwise be lost.
        for (const key of Object.keys(dataContent)) {
          if (key.startsWith('last_auto_healed') || key.startsWith('total_repaired')) {
            srcContent[key] = dataContent[key];
          }
        }
        // Unique temp name: the Python maintenance scripts write this same file,
        // and a shared `.tmp` name lets two writers clobber each other's partial
        // output before either rename lands.
        const tmpPath = `${DATA_FILE}.${process.pid}.${Date.now().toString(36)}.tmp`;
        try {
          fs.writeFileSync(tmpPath, JSON.stringify(srcContent, null, 2), 'utf-8');
          // fsync before rename so the swap cannot expose an unflushed file after
          // a crash, matching the atomic-write contract used elsewhere.
          const handle = fs.openSync(tmpPath, 'r+');
          try {
            fs.fsyncSync(handle);
          } finally {
            fs.closeSync(handle);
          }
          fs.renameSync(tmpPath, DATA_FILE); // Atomic swap: never leave a truncated DB
          resolved = DATA_FILE;
        } catch (e) {
          try {
            fs.rmSync(tmpPath, { force: true });
          } catch {}
          throw e;
        }
      } else if (srcTotal > dataTotal && !srcUsable) {
        console.warn('[Database] Skipped auto-upgrade: bundled catalog is not structurally usable.');
      }
    } else if (fs.existsSync(SRC_FILE) && !fs.existsSync(DATA_FILE)) {
      const dataDir = path.dirname(DATA_FILE);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      fs.copyFileSync(SRC_FILE, DATA_FILE);
      resolved = DATA_FILE;
    }
  } catch (e) {
    console.warn('Failed to verify data/courses_db.json:', e);
  }

  // Recompute: an upgrade may have changed the data file's mtime/size.
  reconcileCache = { signature: statSignature(), dbPath: resolved };
  return resolved;
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
    const exists = fs.existsSync(filePath);
    if (!exists) {
      return NextResponse.json({ error: 'Database file not found' }, { status: 404 });
    }

    const stat = await fs.promises.stat(filePath);
    const mtimeMs = stat.mtimeMs;

    if (!memoryCache || memoryCache.filePath !== filePath || memoryCache.mtimeMs !== mtimeMs) {
      const rawJson = await fs.promises.readFile(filePath, 'utf-8');
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
    console.error('[API/Courses] Error:', error);
    return NextResponse.json({ error: 'Failed to load course database' }, { status: 500 });
  }
}
