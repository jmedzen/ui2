/**
 * The stores that replaced "restore from localStorage in a mount effect".
 *
 * Those effects were rejected by the hooks rules for a real reason: they wrote
 * state after the first paint, so the UI could show the default and then jump.
 * These stores make storage the single source, and `useSyncExternalStore` reads
 * it. The contract that makes that safe is snapshot identity — a fresh object on
 * every call would re-render forever — so it is asserted directly here.
 */
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  createStringStore,
  getKeyedStringStore,
  __resetKeyedStores
} from '../src/lib/stringStore';
import {
  FAVORITES_KEY,
  saveFavorites,
  subscribeFavorites,
  getFavoritesSnapshot,
  getFavoritesServerSnapshot
} from '../src/lib/playbackStore';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

function withStorage() {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k)
  };
  (globalThis as unknown as { window: unknown }).window = { localStorage: storage };
  return map;
}

beforeEach(() => {
  withStorage();
  __resetKeyedStores();
});

test('the snapshot keeps its identity while the stored value is unchanged', () => {
  const store = createStringStore({
    key: 'identity',
    fallback: 'dark',
    parse: (raw) => raw,
    serialize: (v) => v
  });

  // `useSyncExternalStore` compares snapshots by identity; returning a new
  // string-wrapper or object each call is what causes an infinite re-render.
  assert.equal(store.getSnapshot(), store.getSnapshot());
});

test('the server snapshot is always the fallback', () => {
  const store = createStringStore({
    key: 'ssr',
    fallback: 'dark',
    parse: (raw) => raw,
    serialize: (v) => v
  });
  store.set('jade');
  // SSR has no storage, so the server must not see the client's write or the
  // markup would not match on hydration.
  assert.equal(store.getServerSnapshot(), 'dark');
  assert.equal(store.getSnapshot(), 'jade');
});

test('an unparseable stored value falls back instead of throwing', () => {
  const store = createStringStore({
    key: 'junk',
    fallback: 16,
    parse: (raw) => {
      const n = parseInt(raw, 10);
      return !isNaN(n) && n >= 12 && n <= 28 ? n : 16;
    },
    serialize: (v) => String(v)
  });
  (globalThis as unknown as { window: { localStorage: { setItem: (k: string, v: string) => void } } })
    .window.localStorage.setItem('junk', 'not-a-number');
  assert.equal(store.getSnapshot(), 16);

  // Out-of-range values are rejected too, not just non-numeric ones.
  (globalThis as unknown as { window: { localStorage: { setItem: (k: string, v: string) => void } } })
    .window.localStorage.setItem('junk', '999');
  assert.equal(store.getSnapshot(), 16);
});

test('a write notifies subscribers once and a no-op write notifies nobody', () => {
  const store = createStringStore({
    key: 'notify',
    fallback: 'dark',
    parse: (raw) => raw,
    serialize: (v) => v
  });

  let hits = 0;
  const unsubscribe = store.subscribe(() => {
    hits += 1;
  });

  store.set('jade');
  assert.equal(hits, 1);

  // Writing the value that is already stored must not re-render the UI.
  store.set('jade');
  assert.equal(hits, 1);

  unsubscribe();
  store.set('light');
  assert.equal(hits, 1, 'an unsubscribed listener must not be called');
});

test('keyed stores are shared, so two readers of one course agree', () => {
  const a = getKeyedStringStore({
    key: 'fayun_last_tab_97',
    fallback: 'audio',
    parse: (raw) => raw,
    serialize: (v) => v
  });
  const b = getKeyedStringStore({
    key: 'fayun_last_tab_97',
    fallback: 'audio',
    parse: (raw) => raw,
    serialize: (v) => v
  });

  assert.equal(a, b, 'the same key must resolve to the same store');
  a.set('video');
  assert.equal(b.getSnapshot(), 'video');
});

test('favorites notify their subscribers and expose a stable server snapshot', () => {
  const empty = getFavoritesServerSnapshot();
  assert.deepEqual(empty, []);
  // The same array on every call: a fresh `[]` per render would loop.
  assert.equal(getFavoritesServerSnapshot(), empty);

  let hits = 0;
  const unsubscribe = subscribeFavorites(() => {
    hits += 1;
  });

  saveFavorites([{ id: 97, name: '課程', addedAt: 1 } as never]);
  assert.equal(hits, 1);
  assert.equal(getFavoritesSnapshot().length, 1);

  // Writing the same list again is still a real write to storage, but the
  // snapshot must not change identity when the JSON is identical.
  const first = getFavoritesSnapshot();
  saveFavorites([{ id: 97, name: '課程', addedAt: 1 } as never]);
  assert.equal(getFavoritesSnapshot(), first);

  unsubscribe();
});

test('storage keys live in one place per concern', () => {
  assert.equal(FAVORITES_KEY, 'fayun_favorites_v1');
  assert.match(read('src/lib/stringStore.ts'), /export function createStringStore/);
});

test('browser state is read through a store, not mirrored into useState', () => {
  // The regression this guards: a `useState` + mount-effect restore makes the
  // first paint disagree with storage. The stores are now the only writer for
  // these keys, so a component must not declare its own state for them.
  for (const file of ['src/app/page.tsx', 'src/components/CourseDetail.tsx']) {
    const src = read(file);
    assert.doesNotMatch(
      src,
      /useState<ThemePreference>|useState<number>\(16\)|useState<ActiveTab>/,
      `${file} must not keep a local copy of stored browser state`
    );
    assert.doesNotMatch(
      src,
      /localStorage\.setItem\('fayun_(theme|font_size_px|split_ratio)'/,
      `${file} must write through the store instead of touching the key directly`
    );
  }
});
