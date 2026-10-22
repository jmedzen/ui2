import fs from 'node:fs';
import path from 'node:path';

import type { CourseItem } from '@/types/course';

/**
 * Server-side catalog reads for routes that must render a course without the
 * client having fetched `/api/courses` first (deep links, metadata, sitemap).
 *
 * The file lookup and the reconciliation rule deliberately mirror
 * `api/courses/route.ts`: `data/courses_db.json` is the live catalog (the
 * scanner rewrites it), and `src/data/courses_db.json` is the bundled copy that
 * ships with the image. Reading the wrong one would make a shared link show an
 * older catalog than the one the client then loads.
 *
 * The parse is cached by (size, mtime, inode) so a navigation does not re-parse
 * ~900 KB of JSON, and a catalog replaced by rename still invalidates it.
 */

const DATA_FILE = path.join(/*turbopackIgnore: true*/ process.cwd(), 'data', 'courses_db.json');
const SRC_FILE = path.join(/*turbopackIgnore: true*/ process.cwd(), 'src', 'data', 'courses_db.json');

interface CatalogCache {
  signature: string;
  courses: CourseItem[];
  /** id -> course, built once per catalog version. */
  byId: Map<number, CourseItem>;
}

let cache: CatalogCache | null = null;

function resolveCatalogFile(): string {
  if (fs.existsSync(DATA_FILE)) return DATA_FILE;
  return SRC_FILE;
}

function signatureFor(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${file}|${st.size}|${st.mtimeMs}|${st.ino}|${st.ctimeMs}`;
  } catch {
    return `${file}|missing`;
  }
}

function loadCatalog(): CatalogCache {
  const file = resolveCatalogFile();
  const signature = signatureFor(file);
  if (cache && cache.signature === signature) return cache;

  let courses: CourseItem[] = [];
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    const list = (parsed as { courses?: unknown })?.courses;
    if (Array.isArray(list)) {
      // Same boundary validation as the API route: a single malformed row must
      // not take down every course page.
      courses = list.filter((c): c is CourseItem => {
        if (!c || typeof c !== 'object') return false;
        const row = c as Record<string, unknown>;
        return typeof row.id === 'number' && Number.isFinite(row.id) && typeof row.name === 'string';
      });
    }
  } catch {
    courses = [];
  }

  const byId = new Map<number, CourseItem>();
  for (const course of courses) byId.set(course.id, course);

  cache = { signature, courses, byId };
  return cache;
}

/** Every course in the catalog (empty when the file is unreadable). */
export function getCourses(): CourseItem[] {
  return loadCatalog().courses;
}

/** One course by its catalog id, or null. */
export function getCourseById(id: number): CourseItem | null {
  if (!Number.isFinite(id)) return null;
  return loadCatalog().byId.get(Math.trunc(id)) ?? null;
}

/**
 * Parses a route param into a course id.
 *
 * Strict on purpose: `Number('12abc')` is NaN, but `parseInt('12abc')` is 12, so
 * a URL like `/course/12abc` would silently serve course 12 instead of 404ing.
 */
export function parseCourseId(value: string | undefined): number | null {
  if (!value) return null;
  if (!/^\d{1,9}$/.test(value)) return null;
  const id = Number(value);
  return Number.isFinite(id) ? id : null;
}
