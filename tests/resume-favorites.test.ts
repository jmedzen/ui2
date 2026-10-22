import test from 'node:test';
import assert from 'node:assert';

import {
  PROGRESS_KEY,
  FAVORITES_KEY,
  RESUME_MIN_SECONDS,
  RESUME_END_GUARD_SECONDS,
  getEpisodeProgress,
  resumeTimeFor,
  mostRecentProgress,
  getResumeSnapshot,
  readFavorites,
  saveFavorites,
  toggleFavorite,
  isFavorite,
  nextRepeatMode,
  formatSleepRemaining,
  sleepStopClock,
  type ProgressMap,
  type SafeStorage
} from '../src/lib/playbackStore';

/** Minimal in-memory Storage double; the real one is not available in Node. */
function memoryStorage(initial: Record<string, string> = {}): SafeStorage {
  const data: Record<string, string> = { ...initial };
  return {
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => {
      data[k] = v;
    }
  };
}

/**
 * Installs `window.localStorage` for the duration of `fn`.
 *
 * `browserStorage()` reads `window.localStorage` specifically (not
 * `globalThis.localStorage`), so a bare global would leave the store
 * thinking it is on the server.
 */
function withBrowserStorage(initial: Record<string, string>, fn: () => void): void {
  const storage = memoryStorage(initial);
  const g = globalThis as unknown as { window?: unknown };
  const previous = g.window;
  g.window = { localStorage: storage };
  try {
    fn();
  } finally {
    if (previous === undefined) delete g.window;
    else g.window = previous;
  }
}

test('Resume playback', async (t) => {
  await t.test('a barely-started episode is not resumable', () => {
    // Reopening a lecture 8 seconds in should start it from the top, not resume
    // 8 seconds in — that is indistinguishable from "start over" to a reader.
    const p = { t: RESUME_MIN_SECONDS - 1, d: 1800, at: 1 };
    assert.strictEqual(resumeTimeFor(p), 0);
  });

  await t.test('a nearly-finished episode restarts instead of resuming at the end', () => {
    // Resuming 10 seconds before the end replays nothing and re-triggers `ended`.
    const p = { t: 1800 - RESUME_END_GUARD_SECONDS + 5, d: 1800, at: 1 };
    assert.strictEqual(resumeTimeFor(p), 0);
  });

  await t.test('a mid-lecture position resumes exactly', () => {
    const p = { t: 600, d: 1800, at: 1 };
    assert.strictEqual(resumeTimeFor(p), 600);
  });

  await t.test('progress is read back per course and episode', () => {
    const map: ProgressMap = { '7': { 'a.mp3': { t: 120, d: 900, at: 5 } } };
    assert.deepStrictEqual(getEpisodeProgress(map, 7, 'a.mp3'), { t: 120, d: 900, at: 5 });
    assert.strictEqual(getEpisodeProgress(map, 7, 'missing.mp3'), null);
    assert.strictEqual(getEpisodeProgress(map, 8, 'a.mp3'), null);
  });

  await t.test('mostRecentProgress picks the newest save across courses', () => {
    const map: ProgressMap = {
      '1': { 'old.mp3': { t: 100, d: 900, at: 10 } },
      '2': { 'new.mp3': { t: 200, d: 900, at: 99 } }
    };
    const latest = mostRecentProgress(map);
    assert.ok(latest);
    assert.strictEqual(latest!.courseId, 2);
    assert.strictEqual(latest!.filename, 'new.mp3');
  });
});

test('Home resume snapshot', async (t) => {
  await t.test('returns null with no stored progress', () => {
    assert.strictEqual(getResumeSnapshot(), null);
  });

  await t.test('keeps a stable identity while storage is unchanged', () => {
    // useSyncExternalStore re-renders forever if the snapshot identity churns.
    withBrowserStorage(
      { [PROGRESS_KEY]: JSON.stringify({ '3': { 'x.mp3': { t: 300, d: 900, at: 1 } } }) },
      () => {
        const first = getResumeSnapshot();
        const second = getResumeSnapshot();
        assert.ok(first);
        assert.strictEqual(first, second, 'unchanged storage must yield the same object');
        assert.strictEqual(first!.courseId, 3);
        assert.strictEqual(first!.position, 300);
      }
    );
  });

  await t.test('a position below the resume threshold yields no card', () => {
    withBrowserStorage(
      { [PROGRESS_KEY]: JSON.stringify({ '3': { 'x.mp3': { t: 3, d: 900, at: 1 } } }) },
      () => assert.strictEqual(getResumeSnapshot(), null)
    );
  });

  await t.test('corrupted storage yields null rather than throwing', () => {
    withBrowserStorage({ [PROGRESS_KEY]: '{not json' }, () => {
      assert.strictEqual(getResumeSnapshot(), null);
    });
  });
});

test('Favorites', async (t) => {
  await t.test('toggle adds then removes', () => {
    const empty = readFavorites(memoryStorage());
    assert.deepStrictEqual(empty, []);

    const added = toggleFavorite(empty, 97, '瑜伽師地論');
    assert.strictEqual(added.length, 1);
    assert.ok(isFavorite(added, 97));
    assert.strictEqual(added[0].name, '瑜伽師地論');

    const removed = toggleFavorite(added, 97, '瑜伽師地論');
    assert.strictEqual(removed.length, 0);
    assert.ok(!isFavorite(removed, 97));
  });

  await t.test('re-adding moves the course to the front', () => {
    let list = toggleFavorite([], 1, 'A');
    list = toggleFavorite(list, 2, 'B');
    list = toggleFavorite(list, 3, 'C');
    assert.deepStrictEqual(list.map((f) => f.id), [3, 2, 1]);
    // toggling off then on again promotes it
    list = toggleFavorite(list, 1, 'A');
    list = toggleFavorite(list, 1, 'A');
    assert.deepStrictEqual(list.map((f) => f.id), [1, 3, 2]);
  });

  await t.test('a hand-edited entry with no name is dropped', () => {
    // Storage is user-writable; a record without a renderable name is unusable.
    const storage = memoryStorage({
      [FAVORITES_KEY]: JSON.stringify([
        { id: 5, name: 'ok' },
        { id: 6 },
        { id: 'seven', name: 'bad' },
        null,
        { id: 7, name: 42 }
      ])
    });
    const list = readFavorites(storage);
    // Records with no usable id are dropped; a numeric-string id is coerced
    // (older builds wrote ids as strings). A missing name is tolerated because
    // the sidebar renders the name from the catalog, not from this record.
    assert.deepStrictEqual(list.map((f) => f.id), [5, 6, 7]);
    assert.strictEqual(list.find((f) => f.id === 7)!.name, '');
  });

  await t.test('duplicate ids collapse to the first record', () => {
    const storage = memoryStorage({
      [FAVORITES_KEY]: JSON.stringify([
        { id: 5, name: 'first' },
        { id: 5, name: 'second' }
      ])
    });
    const list = readFavorites(storage);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, 'first');
  });

  await t.test('non-array storage yields an empty list', () => {
    assert.deepStrictEqual(readFavorites(memoryStorage({ [FAVORITES_KEY]: '{"a":1}' })), []);
    assert.deepStrictEqual(readFavorites(memoryStorage({ [FAVORITES_KEY]: 'oops' })), []);
  });

  await t.test('save then read round-trips', () => {
    const storage = memoryStorage();
    const list = toggleFavorite(toggleFavorite([], 4, 'D'), 9, 'I');
    assert.ok(saveFavorites(list, storage));
    assert.deepStrictEqual(readFavorites(storage).map((f) => f.id), [9, 4]);
  });
});

test('Player controls', async (t) => {
  await t.test('repeat mode cycles off -> one -> all', () => {
    assert.strictEqual(nextRepeatMode('off'), 'one');
    assert.strictEqual(nextRepeatMode('one'), 'all');
    assert.strictEqual(nextRepeatMode('all'), 'off');
  });

  await t.test('no timer formats as empty, not "0:00"', () => {
    // The player hides the widget when this is empty, so "0:00" would leave a
    // permanent, meaningless countdown on screen.
    assert.strictEqual(formatSleepRemaining(null), '');
  });

  await t.test('sleep remaining counts down and never goes negative', () => {
    const now = 1_000_000_000;
    assert.strictEqual(formatSleepRemaining(now + 65_000, now), '1:05');
    assert.strictEqual(formatSleepRemaining(now + 3_600_000, now), '60:00');
    // A deadline already in the past reports 0:00; the timer stops on tick.
    assert.strictEqual(formatSleepRemaining(now - 30_000, now), '0:00');
  });

  await t.test('the stop clock is a wall-clock time the reader can sanity-check', () => {
    // Derived from an absolute deadline, so a throttled background tab cannot
    // extend playback past the chosen minute.
    const deadline = new Date(2026, 0, 15, 23, 40, 0).getTime();
    assert.strictEqual(sleepStopClock(deadline), '23:40');
  });
});
