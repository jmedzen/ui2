import fs from 'node:fs';
import path from 'node:path';

import { isCatalogRunActive } from './serverTasks';

/**
 * Reconciles the live catalog (`data/courses_db.json`) with the copy bundled in
 * the image (`src/data/courses_db.json`).
 *
 * This used to run inside `GET /api/courses` and decided by COURSE COUNT: if the
 * bundled file listed more courses, it overwrote the live one. Both halves were
 * wrong:
 *
 *  - A count is not a version. A scan or heal that legitimately merges or drops
 *    courses produces a smaller, NEWER catalog. `src/data` lives in the image,
 *    not on the volume, so after every image update it reverts to the build-time
 *    copy — and the next GET (the compose healthcheck polls every 30 s) replaced
 *    the scan's output with that older, larger file. The scan result was lost.
 *  - A GET mutated state, so a health probe could rewrite the catalog.
 *
 * The rule is now "the bundled copy wins only when it is genuinely newer"
 * (by `generated_at`), and the reconciliation runs once at boot from
 * `instrumentation.ts`, when nothing else can be writing the catalog. The
 * course count is used only as a last resort when neither file carries a
 * usable timestamp (legacy catalogs).
 */

export const DATA_CATALOG_FILE = path.join(/*turbopackIgnore: true*/ process.cwd(), 'data', 'courses_db.json');
export const SRC_CATALOG_FILE = path.join(/*turbopackIgnore: true*/ process.cwd(), 'src', 'data', 'courses_db.json');

export type ReconcileAction =
  | 'none'
  | 'seeded'
  | 'upgraded'
  | 'skipped-busy'
  | 'skipped-unusable'
  | 'skipped-not-newer'
  | 'error';

export interface ReconcileOptions {
  dataFile?: string;
  srcFile?: string;
  /** Injected for tests; defaults to the Python lock liveness check. */
  isRunActive?: () => boolean;
}

interface CatalogShape {
  generated_at?: unknown;
  total_courses?: unknown;
  courses?: unknown;
  [key: string]: unknown;
}

/** Parses the scanner's "YYYY-MM-DD HH:MM:SS" (or ISO) stamp; NaN when absent. */
export function catalogTimestamp(value: unknown): number {
  if (typeof value !== 'string' || !value.trim()) return Number.NaN;
  const normalized = value.trim().replace(' ', 'T');
  return Date.parse(normalized);
}

function courseCount(c: CatalogShape): number {
  const declared = Number(c.total_courses);
  if (Number.isFinite(declared) && declared > 0) return declared;
  return Array.isArray(c.courses) ? c.courses.length : 0;
}

function isUsable(c: CatalogShape): boolean {
  return (
    Array.isArray(c.courses) &&
    c.courses.length > 0 &&
    c.courses.every((row: unknown) => row && typeof row === 'object' && (row as { id?: unknown }).id != null)
  );
}

/**
 * Whether the bundled catalog should replace the live one.
 *
 * Exported for tests. Timestamps decide whenever the bundled file has one; a
 * live file without a stamp is treated as older than any stamped bundle.
 */
export function bundledIsNewer(src: CatalogShape, data: CatalogShape): boolean {
  const srcTs = catalogTimestamp(src.generated_at);
  const dataTs = catalogTimestamp(data.generated_at);
  if (Number.isFinite(srcTs) && Number.isFinite(dataTs)) return srcTs > dataTs;
  if (Number.isFinite(srcTs) && !Number.isFinite(dataTs)) return true;
  if (!Number.isFinite(srcTs) && Number.isFinite(dataTs)) return false;
  // Neither is stamped: the legacy count heuristic is all that is left.
  return courseCount(src) > courseCount(data);
}

/** Writes `content` to `target` through a unique, fsynced temp file. */
function atomicWrite(target: string, write: (tmp: string) => void): void {
  const tmpPath = `${target}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    write(tmpPath);
    const handle = fs.openSync(tmpPath, 'r+');
    try {
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(tmpPath, target);
  } catch (e) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {}
    throw e;
  }
}

export function reconcileCatalogFiles(options: ReconcileOptions = {}): ReconcileAction {
  const dataFile = options.dataFile ?? DATA_CATALOG_FILE;
  const srcFile = options.srcFile ?? SRC_CATALOG_FILE;
  const isRunActive = options.isRunActive ?? isCatalogRunActive;

  try {
    if (!fs.existsSync(srcFile)) return 'none';

    if (!fs.existsSync(dataFile)) {
      fs.mkdirSync(path.dirname(dataFile), { recursive: true });
      atomicWrite(dataFile, (tmp) => fs.copyFileSync(srcFile, tmp));
      console.log('[Database] Seeded data/courses_db.json from the bundled catalog.');
      return 'seeded';
    }

    const dataContent = JSON.parse(fs.readFileSync(dataFile, 'utf-8')) as CatalogShape;
    const srcContent = JSON.parse(fs.readFileSync(srcFile, 'utf-8')) as CatalogShape;

    if (!Array.isArray(dataContent.courses)) return 'none';
    if (!bundledIsNewer(srcContent, dataContent)) return 'skipped-not-newer';
    if (!isUsable(srcContent)) {
      console.warn('[Database] Skipped auto-upgrade: bundled catalog is not structurally usable.');
      return 'skipped-unusable';
    }
    // Never reconcile while a Python maintenance run is writing the catalog: the
    // run publishes to data/ and then mirrors to src/data, so rewriting data/ in
    // that window discards the scan's own output.
    if (isRunActive()) {
      console.warn('[Database] Skipped auto-upgrade: a maintenance run is currently writing the catalog.');
      return 'skipped-busy';
    }

    // Preserve the bookkeeping the live file owns and the bundle cannot know.
    for (const key of Object.keys(dataContent)) {
      if (key.startsWith('last_auto_healed') || key.startsWith('total_repaired')) {
        srcContent[key] = dataContent[key];
      }
    }
    atomicWrite(dataFile, (tmp) => fs.writeFileSync(tmp, JSON.stringify(srcContent, null, 2), 'utf-8'));
    console.log(
      `[Database] Upgraded data/courses_db.json to the newer bundled catalog ` +
        `(${String(dataContent.generated_at)} -> ${String(srcContent.generated_at)}).`
    );
    return 'upgraded';
  } catch (e) {
    console.warn('[Database] Failed to reconcile data/courses_db.json:', e);
    return 'error';
  }
}
