/**
 * A tiny localStorage-backed external store.
 *
 * Several pieces of UI state (theme, font size, split ratio, the active tab and
 * the selected video) are read from `localStorage` after mount and then written
 * back on user interaction. Written as `useState` + `useEffect`, that shape is
 * rejected by the hooks rules: setting state synchronously in an effect forces a
 * second render before the first one has painted, and it makes the stored value
 * and the rendered value two independent things that can drift.
 *
 * `useSyncExternalStore` is the documented answer, and it needs three pieces:
 * a subscribe function, a client snapshot, and a server snapshot. This factory
 * builds all three for a single key, so each call site only declares how to
 * parse and serialise its value.
 *
 * The snapshot is memoised against the raw string because
 * `useSyncExternalStore` requires a stable identity — returning a fresh object
 * on every call would re-render forever.
 */

export interface StringStoreOptions<T> {
  /** localStorage key. */
  key: string;
  /** Value used on the server, before hydration, and when storage is empty. */
  fallback: T;
  /** Validates and converts the stored string. Return `fallback` if unusable. */
  parse: (raw: string) => T;
  /** Converts a value to the stored string. */
  serialize: (value: T) => string;
}

export interface StringStore<T> {
  /** Read the current value outside React (event handlers, effects). */
  get: () => T;
  /** Persist a value and re-render every subscribed component. */
  set: (value: T) => void;
  /** Subscribe to changes made through this store. */
  subscribe: (listener: () => void) => () => void;
  /** Stable snapshot for `useSyncExternalStore`. */
  getSnapshot: () => T;
  /** Server snapshot for `useSyncExternalStore`; always the fallback. */
  getServerSnapshot: () => T;
  /** Test-only: drop module state. */
  reset: () => void;
}

export function createStringStore<T>(options: StringStoreOptions<T>): StringStore<T> {
  const { key, fallback, parse, serialize } = options;

  let listeners = new Set<() => void>();
  let cachedRaw: string | null | undefined;
  let cachedValue: T = fallback;

  const readRaw = (): string | null => {
    try {
      if (typeof window === 'undefined') return null;
      if (!window.localStorage) return null;
      return window.localStorage.getItem(key);
    } catch {
      // Storage can be blocked entirely (private mode, policy).
      return null;
    }
  };

  const getSnapshot = (): T => {
    const raw = readRaw();
    if (raw === cachedRaw) return cachedValue;
    cachedRaw = raw;
    cachedValue = raw === null ? fallback : parse(raw);
    return cachedValue;
  };

  const set = (value: T): void => {
    const raw = serialize(value);
    if (raw === cachedRaw) return;
    cachedRaw = raw;
    cachedValue = value;
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(key, raw);
      }
    } catch {}
    for (const listener of listeners) listener();
  };

  return {
    get: getSnapshot,
    set,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot,
    getServerSnapshot: () => fallback,
    reset: () => {
      listeners = new Set();
      cachedRaw = undefined;
      cachedValue = fallback;
    }
  };
}


/**
 * Memoised stores for keys built at runtime (e.g. one per course).
 *
 * `CourseDetail` persists the active tab and the video index under
 * `fayun_last_tab_<id>` / `fayun_last_video_idx_<id>`, so the key is not known
 * until the course is. Caching by key keeps the snapshot identity stable across
 * renders, which `useSyncExternalStore` requires.
 */
const keyedStores = new Map<string, StringStore<unknown>>();

export function getKeyedStringStore<T>(options: StringStoreOptions<T>): StringStore<T> {
  const existing = keyedStores.get(options.key);
  if (existing) return existing as StringStore<T>;
  const created = createStringStore(options);
  keyedStores.set(options.key, created as StringStore<unknown>);
  return created;
}

/** Test-only: drop every keyed store. */
export function __resetKeyedStores(): void {
  for (const store of keyedStores.values()) store.reset();
  keyedStores.clear();
}
