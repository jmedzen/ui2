/**
 * Browser-side persistence for listening progress, bookmarks and player
 * preferences.
 *
 * Everything here is deliberately framework-free and storage-injectable so the
 * pruning and clamping rules can be unit-tested without a DOM. The React
 * components treat these functions as the single source of truth: a component
 * never reads `localStorage` directly, which is what keeps the key names, the
 * validation rules and the size caps in one place.
 *
 * Why a cap at all: the catalog has 684 courses and some have hundreds of
 * episodes. A naive `fayun_progress` blob would grow without limit until Safari
 * (5 MB per origin) starts throwing QuotaExceededError on every write — and the
 * writes happen every few seconds during playback, so a single overflow would
 * spam the console forever. Records are therefore pruned oldest-first.
 */

export const PROGRESS_KEY = 'fayun_progress_v1';
export const FAVORITES_KEY = 'fayun_favorites_v1';
export const PLAYER_PREFS_KEY = 'fayun_player_prefs_v1';

/** How many distinct courses may keep a resume point. */
export const MAX_PROGRESS_COURSES = 200;
/** How many episodes per course may keep a resume point. */
export const MAX_PROGRESS_EPISODES = 400;
export const MAX_FAVORITES = 500;

/**
 * A position closer than this to either end is not worth resuming.
 *
 * Restarting a 3-second sliver is noise, and "resume at 0:02" looks broken;
 * resuming within the last few seconds just triggers an immediate advance.
 */
export const RESUME_MIN_SECONDS = 15;
export const RESUME_END_GUARD_SECONDS = 30;

export interface EpisodeProgress {
  /** Last known playhead, in seconds. */
  t: number;
  /** Episode duration in seconds, when known (0 when metadata never loaded). */
  d: number;
  /** Epoch ms of the last update, used for pruning and "continue" ordering. */
  at: number;
}

/** courseId -> (episode filename -> progress). */
export type ProgressMap = Record<string, Record<string, EpisodeProgress>>;

export interface FavoriteRecord {
  id: number;
  name: string;
  at: number;
}

export type RepeatMode = 'off' | 'one' | 'all';

export interface PlayerPrefs {
  rate: number;
  volume: number;
  muted: boolean;
  repeat: RepeatMode;
}

export const DEFAULT_PLAYER_PREFS: PlayerPrefs = {
  rate: 1,
  volume: 1,
  muted: false,
  repeat: 'all'
};

/** The subset of the Web Storage API this module needs. */
export interface SafeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Returns `localStorage` when available, otherwise null (SSR, private mode). */
export function browserStorage(): SafeStorage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    // Accessing localStorage itself throws when storage is blocked by policy.
    return null;
  }
}

function readJson(storage: SafeStorage | null, key: string): unknown {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function writeJson(storage: SafeStorage | null, key: string, value: unknown): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function finiteNonNegative(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/** Stable, storage-safe key for a course id. */
function courseKey(courseId: number): string {
  return String(Math.trunc(courseId));
}

/**
 * Reads the whole progress map, discarding any entry that does not survive
 * validation.
 *
 * `localStorage` is user-writable and survives upgrades, so a hand-edited or
 * half-written value must not reach the render path: a non-numeric `t` would
 * render "NaN:NaN" and could seek a media element to NaN (which throws).
 */
export function readProgressMap(storage: SafeStorage | null = browserStorage()): ProgressMap {
  const raw = readJson(storage, PROGRESS_KEY);
  if (!raw || typeof raw !== 'object') return {};

  const out: ProgressMap = {};
  for (const [cid, episodes] of Object.entries(raw as Record<string, unknown>)) {
    if (!episodes || typeof episodes !== 'object') continue;
    const cleaned: Record<string, EpisodeProgress> = {};
    for (const [filename, value] of Object.entries(episodes as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const rec = value as Record<string, unknown>;
      const t = finiteNonNegative(rec.t);
      const d = finiteNonNegative(rec.d);
      const at = finiteNonNegative(rec.at);
      if (t <= 0 || at <= 0) continue;
      // A position past the end of a known duration is stale (the file was
      // replaced, or the duration shrank); do not offer to resume there.
      if (d > 0 && t >= d) continue;
      cleaned[filename] = { t, d, at };
    }
    if (Object.keys(cleaned).length > 0) out[cid] = cleaned;
  }
  return out;
}

/**
 * Drops the oldest course records once the map exceeds the cap.
 *
 * Mutates the provided map (which callers own) and returns it for chaining.
 */
export function pruneProgressMap(map: ProgressMap, maxCourses = MAX_PROGRESS_COURSES): ProgressMap {
  const ids = Object.keys(map);
  if (ids.length <= maxCourses) return map;

  const ranked = ids
    .map((id) => {
      const episodes = map[id] || {};
      const newest = Object.values(episodes).reduce((acc, e) => Math.max(acc, e.at), 0);
      return { id, newest };
    })
    .sort((a, b) => b.newest - a.newest);

  for (const { id } of ranked.slice(maxCourses)) {
    delete map[id];
  }
  return map;
}

export function getEpisodeProgress(
  map: ProgressMap,
  courseId: number,
  filename: string
): EpisodeProgress | null {
  return map[courseKey(courseId)]?.[filename] ?? null;
}

/**
 * Decides where playback should start for an episode.
 *
 * Returns 0 when there is nothing worth resuming, so callers can apply the
 * result unconditionally without an extra branch.
 */
export function resumeTimeFor(progress: EpisodeProgress | null): number {
  if (!progress) return 0;
  const { t, d } = progress;
  if (!Number.isFinite(t) || t < RESUME_MIN_SECONDS) return 0;
  if (d > 0 && t >= d - RESUME_END_GUARD_SECONDS) return 0;
  return t;
}

/**
 * Records a playhead position.
 *
 * Returns a NEW map rather than mutating, so React state identity changes and
 * the write can be skipped when nothing moved. `at` is injectable for tests.
 */
export function setEpisodeProgress(
  map: ProgressMap,
  courseId: number,
  filename: string,
  position: number,
  duration: number,
  now: number = Date.now()
): ProgressMap {
  const t = finiteNonNegative(position);
  const d = finiteNonNegative(duration);
  if (!filename) return map;

  const key = courseKey(courseId);
  const episodes: Record<string, EpisodeProgress> = { ...(map[key] || {}) };

  // A finished episode must not keep a resume point, otherwise "resume" would
  // jump to the end and immediately advance to the next episode.
  if (t <= 0 || (d > 0 && t >= d - 1)) {
    delete episodes[filename];
  } else {
    episodes[filename] = { t, d, at: now };
  }

  const next: ProgressMap = { ...map };
  if (Object.keys(episodes).length === 0) {
    delete next[key];
  } else {
    // Bound the per-course episode count: keep the most recent positions.
    const trimmed: Record<string, EpisodeProgress> = {};
    Object.entries(episodes)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_PROGRESS_EPISODES)
      .forEach(([name, value]) => {
        trimmed[name] = value;
      });
    next[key] = trimmed;
  }

  return pruneProgressMap(next);
}

export function saveProgressMap(
  map: ProgressMap,
  storage: SafeStorage | null = browserStorage()
): boolean {
  const ok = writeJson(storage, PROGRESS_KEY, map);
  progressListeners.forEach((listener) => listener());
  return ok;
}

/**
 * Subscription channel for progress changes.
 *
 * The audio provider writes progress every few seconds, and one component (the
 * home page's "continue listening" card) has to react to it. Publishing the
 * cache write here is what lets that component read the value through
 * `useSyncExternalStore` — reading it in an effect and copying it into state
 * would be a `setState` in an effect, and a cross-tab write would then need a
 * second notification path.
 */
const progressListeners = new Set<() => void>();

export function subscribeProgress(listener: () => void): () => void {
  progressListeners.add(listener);
  return () => {
    progressListeners.delete(listener);
  };
}

/**
 * Stable snapshot of the newest resume point across all courses.
 *
 * `useSyncExternalStore` requires the same object identity while the underlying
 * data is unchanged, so the derived record is memoised against the raw JSON
 * string. Re-parsing on every call would hand React a fresh object each time
 * and loop. Returns null when there is nothing worth resuming.
 */
let snapshotRaw: string | null | undefined;
let snapshotValue: HomeResumePoint | null = null;

export interface HomeResumePoint {
  courseId: number;
  filename: string;
  position: number;
  duration: number;
  /** Timestamp of the last save, used only for ordering. */
  at: number;
}

export function getResumeSnapshot(): HomeResumePoint | null {
  const storage = browserStorage();
  let raw: string | null = null;
  try {
    raw = storage?.getItem(PROGRESS_KEY) ?? null;
  } catch {
    raw = null;
  }

  if (raw === snapshotRaw) return snapshotValue;
  snapshotRaw = raw;

  let map: ProgressMap = {};
  try {
    map = raw ? (JSON.parse(raw) as ProgressMap) : {};
  } catch {
    map = {};
  }

  const latest = mostRecentProgress(map);
  if (!latest) {
    snapshotValue = null;
    return snapshotValue;
  }

  const position = resumeTimeFor(latest.progress);
  snapshotValue =
    position > 0
      ? {
          courseId: latest.courseId,
          filename: latest.filename,
          position,
          duration: latest.progress.d,
          at: latest.progress.at
        }
      : null;
  return snapshotValue;
}

/**
 * Server-rendering snapshot: always null.
 *
 * The server has no localStorage, and rendering `null` on both sides' first
 * pass is what keeps hydration consistent; the real value arrives immediately
 * after via the subscription.
 */
export function getResumeServerSnapshot(): HomeResumePoint | null {
  return null;
}

/** Newest episode of a course that is worth resuming, or null. */
export function latestEpisodeFor(
  map: ProgressMap,
  courseId: number
): { filename: string; progress: EpisodeProgress } | null {
  const episodes = map[courseKey(courseId)];
  if (!episodes) return null;
  let best: { filename: string; progress: EpisodeProgress } | null = null;
  for (const [filename, progress] of Object.entries(episodes)) {
    if (resumeTimeFor(progress) <= 0) continue;
    if (!best || progress.at > best.progress.at) best = { filename, progress };
  }
  return best;
}

/**
 * Most recently played episode across every course.
 *
 * Powers the home page "continue" card, which must survive a reload even when
 * the last selected course is not the one that was actually played.
 */
export function mostRecentProgress(
  map: ProgressMap
): { courseId: number; filename: string; progress: EpisodeProgress } | null {
  let best: { courseId: number; filename: string; progress: EpisodeProgress } | null = null;
  for (const [cid, episodes] of Object.entries(map)) {
    const courseId = Number(cid);
    if (!Number.isFinite(courseId)) continue;
    for (const [filename, progress] of Object.entries(episodes)) {
      if (resumeTimeFor(progress) <= 0) continue;
      if (!best || progress.at > best.progress.at) best = { courseId, filename, progress };
    }
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * Favorites
 * ------------------------------------------------------------------ */

export function readFavorites(storage: SafeStorage | null = browserStorage()): FavoriteRecord[] {
  const raw = readJson(storage, FAVORITES_KEY);
  if (!Array.isArray(raw)) return [];

  const seen = new Set<number>();
  const out: FavoriteRecord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === 'number' ? rec.id : Number(rec.id);
    if (!Number.isFinite(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: typeof rec.name === 'string' ? rec.name : '',
      at: finiteNonNegative(rec.at) || Date.now()
    });
  }
  return out.slice(0, MAX_FAVORITES);
}

export function isFavorite(favorites: FavoriteRecord[], courseId: number): boolean {
  return favorites.some((f) => f.id === courseId);
}

/**
 * Toggles a course in the favorites list, newest first.
 *
 * Capped at MAX_FAVORITES so the header chip list and the JSON blob both stay
 * bounded; the oldest entry is dropped rather than refusing the new one, since
 * the user just expressed interest in the new course.
 */
export function toggleFavorite(
  favorites: FavoriteRecord[],
  courseId: number,
  name: string,
  now: number = Date.now()
): FavoriteRecord[] {
  if (isFavorite(favorites, courseId)) {
    return favorites.filter((f) => f.id !== courseId);
  }
  return [{ id: courseId, name, at: now }, ...favorites].slice(0, MAX_FAVORITES);
}

export function saveFavorites(
  favorites: FavoriteRecord[],
  storage: SafeStorage | null = browserStorage()
): boolean {
  const ok = writeJson(storage, FAVORITES_KEY, favorites);
  favoriteListeners.forEach((listener) => listener());
  return ok;
}

/**
 * Subscription channel for the favorites list.
 *
 * The list is read back after mount and written on every toggle. Mirrored into
 * `useState` by an effect that was two sources of truth (and a `setState` in an
 * effect); publishing the write here lets the reader subscribe with
 * `useSyncExternalStore` instead.
 */
const favoriteListeners = new Set<() => void>();

export function subscribeFavorites(listener: () => void): () => void {
  favoriteListeners.add(listener);
  return () => {
    favoriteListeners.delete(listener);
  };
}

const EMPTY_FAVORITES: FavoriteRecord[] = [];
let favoritesSnapshotRaw: string | null | undefined;
let favoritesSnapshotValue: FavoriteRecord[] = EMPTY_FAVORITES;

/**
 * Snapshot of the stored favorites.
 *
 * Memoised against the raw JSON string: `useSyncExternalStore` loops forever if
 * the snapshot gets a new identity while the underlying data is unchanged, and
 * `readFavorites` builds a new array on every call.
 */
export function getFavoritesSnapshot(): FavoriteRecord[] {
  const storage = browserStorage();
  let raw: string | null = null;
  try {
    raw = storage?.getItem(FAVORITES_KEY) ?? null;
  } catch {
    raw = null;
  }

  if (raw === favoritesSnapshotRaw) return favoritesSnapshotValue;
  favoritesSnapshotRaw = raw;
  favoritesSnapshotValue = readFavorites(storage);
  return favoritesSnapshotValue;
}

/** The server has no storage, so SSR renders no favorites. */
export function getFavoritesServerSnapshot(): FavoriteRecord[] {
  return EMPTY_FAVORITES;
}

/* ------------------------------------------------------------------ *
 * Player preferences
 * ------------------------------------------------------------------ */

const REPEAT_MODES: RepeatMode[] = ['off', 'one', 'all'];
const ALLOWED_RATES = [0.75, 1, 1.25, 1.5, 2];

export function readPlayerPrefs(storage: SafeStorage | null = browserStorage()): PlayerPrefs {
  const raw = readJson(storage, PLAYER_PREFS_KEY);
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PLAYER_PREFS };
  const rec = raw as Record<string, unknown>;

  const rate = ALLOWED_RATES.includes(Number(rec.rate)) ? Number(rec.rate) : DEFAULT_PLAYER_PREFS.rate;
  const volumeRaw = Number(rec.volume);
  const volume = Number.isFinite(volumeRaw)
    ? Math.max(0, Math.min(1, volumeRaw))
    : DEFAULT_PLAYER_PREFS.volume;

  return {
    rate,
    volume,
    muted: rec.muted === true,
    repeat: REPEAT_MODES.includes(rec.repeat as RepeatMode)
      ? (rec.repeat as RepeatMode)
      : DEFAULT_PLAYER_PREFS.repeat
  };
}

export function savePlayerPrefs(
  prefs: PlayerPrefs,
  storage: SafeStorage | null = browserStorage()
): boolean {
  return writeJson(storage, PLAYER_PREFS_KEY, prefs);
}

export function nextRepeatMode(mode: RepeatMode): RepeatMode {
  const idx = REPEAT_MODES.indexOf(mode);
  return REPEAT_MODES[(idx + 1) % REPEAT_MODES.length];
}

/** Human-readable label for the repeat control. */
export const REPEAT_LABELS: Record<RepeatMode, string> = {
  off: '🔁 不循環',
  one: '🔂 單集循環',
  all: '🔁 連續播放'
};

/* ------------------------------------------------------------------ *
 * Sleep timer
 * ------------------------------------------------------------------ */

export interface SleepTimerState {
  /** Epoch ms when playback should stop, or null when no timer is armed. */
  endsAt: number | null;
  /** True when the timer should fire at the end of the current episode. */
  endOfEpisode: boolean;
}

export const SLEEP_OFF: SleepTimerState = { endsAt: null, endOfEpisode: false };

/** Formats the remaining time on the sleep timer for the player bar. */
export function formatSleepRemaining(endsAt: number | null, now: number = Date.now()): string {
  if (!endsAt) return '';
  const remaining = Math.max(0, Math.ceil((endsAt - now) / 1000));
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Clock time (local) at which the timer will stop, e.g. "23:40". */
export function sleepStopClock(endsAt: number): string {
  const d = new Date(endsAt);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}
