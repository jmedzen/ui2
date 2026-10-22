import type { CourseItem } from '@/types/course';

/**
 * Daily rotating recommendations.
 *
 * "Every 24 hours" is implemented as a per-day deterministic selection rather
 * than as `Math.random()` plus a stored timestamp, because the two naive
 * alternatives are both wrong here:
 *
 *  - `Math.random()` during render produces a different trio on every render,
 *    and the server/client renders disagree (hydration mismatch).
 *  - Persisting "picked at" in localStorage gives each visitor their own
 *    rotation, so the site has no shared "today's picks" and a private window
 *    starts from scratch.
 *
 * Deriving the picks from (day, catalog) makes them identical for everyone,
 * stable across reloads within a day, and server-renderable.
 *
 * The day boundary is pinned to UTC+8 (Asia/Taipei) instead of the host's
 * timezone. The container typically runs in UTC, so a local-time day would roll
 * over at 08:00 for the audience this site is written for.
 */

export const RECOMMENDATION_TIMEZONE_OFFSET_MINUTES = 8 * 60;
export const DAILY_PICK_COUNT = 3;

/**
 * The UTC+8 calendar day as an integer (days since the Unix epoch).
 *
 * Shifting by the offset and then flooring to whole days is what makes the
 * value change exactly once, at 00:00 Taipei time, with no DST exception (the
 * offset has no DST), so the rotation period is a true 24 hours.
 */
export function dayIndexFor(nowMs: number): number {
  return Math.floor((nowMs + RECOMMENDATION_TIMEZONE_OFFSET_MINUTES * 60_000) / 86_400_000);
}

/** Milliseconds until the next UTC+8 midnight, floored at 1. */
export function msUntilNextDay(nowMs: number): number {
  const shifted = nowMs + RECOMMENDATION_TIMEZONE_OFFSET_MINUTES * 60_000;
  const intoDay = shifted % 86_400_000;
  return 86_400_000 - intoDay || 86_400_000;
}

/** `YYYY-MM-DD` for the UTC+8 day that contains `nowMs`. */
export function dayLabelFor(nowMs: number): string {
  return dayLabelFromIndex(dayIndexFor(nowMs));
}

/**
 * `YYYY-MM-DD` from a day index.
 *
 * Taking the index rather than a timestamp keeps the label a pure function of
 * the suspended-time value the picker already uses, so rendering it cannot
 * read the clock mid-render.
 */
export function dayLabelFromIndex(dayIndex: number): string {
  const shifted = new Date(dayIndex * 86_400_000);
  const y = shifted.getUTCFullYear();
  const m = (shifted.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = shifted.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 32-bit integer hash of a day and a course id.
 *
 * Uses the murmur3 finalizer over a small mixed seed: consecutive course ids
 * are extremely close numerically, and a weak hash would rank them in catalog
 * order, so the same courses would keep surfacing together.
 */
function hashSeed(dayIndex: number, courseId: number): number {
  let h = (dayIndex | 0) ^ Math.imul(courseId | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * A course is recommendable when it actually contains something to open.
 *
 * Three catalog rows have no audio, video or PDF at all; recommending one would
 * send the reader to an empty course page.
 */
export function isRecommendable(course: CourseItem): boolean {
  if (!course || typeof course.id !== 'number' || !Number.isFinite(course.id)) return false;
  if (!course.name || !course.name.trim()) return false;
  return Boolean(
    (course.audio_path && course.audio_path.trim()) ||
      (course.video_path && course.video_path.trim()) ||
      (course.pdfs && course.pdfs.length > 0)
  );
}

/** Total distinct categories, used for the "spread across topics" guarantee. */
function topicKeyFor(course: CourseItem): string {
  return (course.topic_title || course.sub_menu_title || course.main_menu_title || '').trim();
}

/**
 * Sampling weight: how deserving a course is of a recommendation slot.
 *
 * Uniform sampling looked wrong in practice. 377 of the 684 courses are single
 * one-episode clips (法語珠璣 197, 佛典與高僧故事 180), so over half of all
 * picks were a 1-講 audio bite — fine as a browser entry, odd as the
 * recommendation shown directly above 瑜伽師地論 and 金剛經.
 *
 * The curve is deliberately gentle (square root, not linear): a 478-episode
 * course is ~11x more likely than a 1-episode clip, not 478x, so the section
 * still surfaces short, obscure talks rather than cycling the same handful of
 * blockbusters. PDFs count because a lecture-note-only course is still study
 * material.
 */
export function weightForCourse(course: CourseItem): number {
  const episodes = Math.max(0, course.total_episodes || 0);
  const pdfs = course.pdfs?.length || 0;
  return 1 + Math.sqrt(episodes) + Math.sqrt(pdfs);
}

export interface PickOptions {
  /** Course ids to never recommend, e.g. the fixed flagship cards below. */
  excludeIds?: Iterable<number>;
}

/**
 * Deterministically picks `count` courses for the given day.
 *
 * Ranking uses weighted sampling without replacement (Efraimidis–Spirakis): each
 * course gets a pseudo-random `u` from the day-and-id hash, and the key is
 * `u^(1/weight)`. Taking the top keys is exactly weighted sampling without
 * replacement, and it stays a pure function of (day, catalog), so the server and
 * the client agree.
 *
 * The greedy pass then prefers a course from a category not already chosen, so
 * the trio does not come back as three clips from the same bucket. When
 * distinct categories run out, the remaining slots are filled from the overall
 * ranking so the section never renders short.
 */
export function pickDailyPicks(
  courses: CourseItem[],
  dayIndex: number,
  count: number = DAILY_PICK_COUNT,
  options: PickOptions = {}
): CourseItem[] {
  if (!Array.isArray(courses) || courses.length === 0 || count <= 0) return [];

  const excluded = new Set(options.excludeIds ?? []);

  const ranked = courses
    .filter((course) => isRecommendable(course) && !excluded.has(course.id))
    .map((course) => {
      const hash = hashSeed(dayIndex, course.id);
      // Map to (0,1]; +1 keeps the value strictly positive so the exponent
      // below cannot produce 0 for every course.
      const u = (hash + 1) / 4_294_967_297;
      return { course, key: Math.pow(u, 1 / weightForCourse(course)) };
    })
    // Tie-break on id so the order is total: two courses sharing a key must not
    // swap places between the server render and the client render.
    .sort((a, b) => b.key - a.key || a.course.id - b.course.id)
    .map((entry) => entry.course);

  const picked: CourseItem[] = [];
  const usedTopics = new Set<string>();

  for (const course of ranked) {
    if (picked.length >= count) break;
    const topic = topicKeyFor(course);
    if (topic && usedTopics.has(topic)) continue;
    usedTopics.add(topic);
    picked.push(course);
  }

  // Fewer distinct categories than requested (small or highly concentrated
  // catalogs): top up without the uniqueness constraint.
  for (const course of ranked) {
    if (picked.length >= count) break;
    if (!picked.includes(course)) picked.push(course);
  }

  return picked;
}

/** A short, factual line for a recommendation card. */
export function describeCourse(course: CourseItem): string {
  const comment = (course.comment || '').trim();
  if (comment) {
    const oneLine = comment.replace(/\s+/g, ' ').trim();
    return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
  }

  const parts: string[] = [];
  const episodeCount = course.total_episodes || 0;
  if (episodeCount > 0) parts.push(`共 ${episodeCount} 講`);
  if (course.video_path) parts.push('附影音講記');
  const pdfCount = course.pdfs?.length || 0;
  if (pdfCount > 0) parts.push(`${pdfCount} 份手稿講義`);
  if (parts.length === 0) parts.push('典藏講記');

  const branch = course.sub_menu_title || course.main_menu_title || '';
  return branch ? `${branch}　${parts.join(' · ')}` : parts.join(' · ');
}

const CARD_ICONS = ['📖', '🪷', '🧘', '💎', '🏛️', '📜', '🌸', '☸️'];

/** Stable per-course icon, so a card does not change face between renders. */
export function iconForCourse(course: CourseItem): string {
  return CARD_ICONS[Math.abs(course.id) % CARD_ICONS.length];
}
