/**
 * Recently-studied course ids, shared by the sidebar and the writer.
 *
 * This lives outside React because the previous shape was an effect that both
 * read `localStorage` on mount and wrote it whenever the selection changed.
 * Writing state from an effect is the pattern the hooks rules reject (it causes
 * a second render per selection, and interleaves badly with concurrent
 * rendering), and it made the reader and the writer two independent code paths
 * that could disagree about the bound.
 *
 * Reading through `useSyncExternalStore` and writing from the click handler puts
 * the read, the write, the validation and the cap in one place.
 */

export const RECENT_COURSES_STORAGE_KEY = 'fayun_recent_course_ids';

/** How many recently-studied courses the sidebar shows. */
export const MAX_RECENT_COURSES = 4;

const EMPTY: readonly number[] = Object.freeze([]);
/** Shared identity for the server render and for an empty list. */
const EMPTY_SNAPSHOT: number[] = EMPTY as number[];

let listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedValue: number[] = EMPTY_SNAPSHOT;

/**
 * Parses and validates the stored value.
 *
 * localStorage is user-writable and survives upgrades, so the stored value
 * cannot be trusted: only finite numeric ids are kept, and at most the number
 * this feature displays. Otherwise a corrupted or hand-edited entry would be
 * held forever and re-persisted on every visit.
 */
export function parseRecentCourseIds(raw: string | null): number[] {
  if (!raw) return EMPTY_SNAPSHOT;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return EMPTY_SNAPSHOT;
    return parsed
      .filter((id): id is number => typeof id === 'number' && Number.isFinite(id))
      .slice(0, MAX_RECENT_COURSES);
  } catch {
    return EMPTY_SNAPSHOT;
  }
}

function readRaw(): string | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(RECENT_COURSES_STORAGE_KEY);
  } catch {
    // Storage can be blocked entirely (private mode, policy).
    return null;
  }
}

/**
 * Snapshot of the recent list.
 *
 * Memoised against the raw string because `useSyncExternalStore` requires a
 * stable identity: returning a fresh array on each call re-renders forever.
 */
export function getRecentCoursesSnapshot(): number[] {
  const raw = readRaw();
  if (raw === cachedRaw) return cachedValue;
  cachedRaw = raw;
  cachedValue = parseRecentCourseIds(raw);
  return cachedValue;
}

/** The server has no storage, so SSR always renders the empty list. */
export function getRecentCoursesServerSnapshot(): number[] {
  return EMPTY_SNAPSHOT;
}

export function subscribeRecentCourses(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify() {
  for (const listener of listeners) listener();
}

/**
 * Records a course as most-recently-studied and persists the result.
 *
 * Deduplicates first so re-opening the current course moves it to the front
 * instead of appearing twice, and drops the oldest entry past the cap.
 */
export function pushRecentCourse(courseId: number): number[] {
  if (typeof courseId !== 'number' || !Number.isFinite(courseId)) return cachedValue;

  const previous = getRecentCoursesSnapshot();
  const filtered = previous.filter((id) => id !== courseId);
  const updated = [courseId, ...filtered].slice(0, MAX_RECENT_COURSES);

  // Nothing to persist when the list is already in this order (re-selecting the
  // course that is already first).
  const unchanged =
    updated.length === previous.length && updated.every((id, i) => id === previous[i]);

  cachedRaw = JSON.stringify(updated);
  cachedValue = updated;

  if (!unchanged) {
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(RECENT_COURSES_STORAGE_KEY, cachedRaw);
      }
    } catch {}
    notify();
  }

  return updated;
}

/** Test-only: clears module state so cases do not leak into each other. */
export function __resetRecentCourses(): void {
  listeners = new Set();
  cachedRaw = undefined;
  cachedValue = EMPTY_SNAPSHOT;
}
