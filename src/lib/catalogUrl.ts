/**
 * URL <-> selection mapping for the catalog.
 *
 * The app is a single page at `/`, so the URL is not derived from the route
 * segment: it is maintained with the History API. `next.config.ts` rewrites
 * `/course/:id` and `/course/:id/ep/:ep` to `/`, which is what makes a shared
 * link work on a cold load without remounting the shell (and stopping audio).
 *
 * Keeping the parse/format pair here means the writer (selection changes) and
 * the reader (cold load, back/forward) can never drift, and both are testable
 * without a DOM.
 */

export const HOME_PATH = '/';
export const COURSE_PATH_PREFIX = '/course';

export interface CatalogLocation {
  courseId: number | null;
  /** 1-based episode number as it appears in the URL, or null. */
  episode: number | null;
}

/** Builds the canonical URL for a selection. */
export function buildCoursePath(courseId: number | null, episode?: number | null): string {
  if (courseId === null || !Number.isFinite(courseId) || courseId <= 0) return HOME_PATH;
  const id = Math.trunc(courseId);
  if (episode === null || episode === undefined) return `${COURSE_PATH_PREFIX}/${id}`;
  const ep = Math.trunc(episode);
  if (!Number.isFinite(ep) || ep <= 0) return `${COURSE_PATH_PREFIX}/${id}`;
  return `${COURSE_PATH_PREFIX}/${id}/ep/${ep}`;
}

/**
 * Parses a pathname (and optional search string) back into a selection.
 *
 * Accepts the `?ep=` query form as well as the `/ep/` segment form: the query
 * form is what older shared links used, and it is also what the in-page episode
 * list writes so that switching episodes does not push a new history entry for
 * every click.
 */
export function parseCatalogPath(pathname: string, search = ''): CatalogLocation {
  const path = (pathname || '').split('#')[0];
  const match = path.match(/^\/course\/(\d{1,9})(?:\/ep\/(\d{1,6}))?\/?$/);

  let courseId: number | null = null;
  let episode: number | null = null;

  if (match) {
    courseId = Number(match[1]);
    if (match[2]) episode = Number(match[2]);
  }

  // Query parameters take precedence over the segment form, so `/course/97?ep=3`
  // behaves the same as `/course/97/ep/3`.
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const queryEp = params.get('ep');
  if (queryEp && /^\d{1,6}$/.test(queryEp)) {
    episode = Number(queryEp);
  }

  return {
    courseId: Number.isFinite(courseId) && (courseId as number) > 0 ? courseId : null,
    episode: Number.isFinite(episode as number) && (episode as number) > 0 ? episode : null
  };
}

/** Pathname + search for the current browser location, or a safe default. */
export function currentCatalogLocation(): CatalogLocation {
  if (typeof window === 'undefined') return { courseId: null, episode: null };
  try {
    return parseCatalogPath(window.location.pathname, window.location.search);
  } catch {
    return { courseId: null, episode: null };
  }
}
