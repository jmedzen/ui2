import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

/**
 * Regression tests for the playback-speed reset.
 *
 * The WHATWG media load algorithm — run by every `load()` and by every `src`
 * assignment — ends with "Set the playbackRate attribute to the value of the
 * defaultPlaybackRate attribute". `defaultPlaybackRate` defaults to 1.0 and was
 * never assigned anywhere in this repo, so the chosen speed was silently
 * discarded on every track/episode change:
 *
 *   AudioContext.playTrack    src -> playbackRate = chosen -> load()  (back to 1.0)
 *   AudioContext.handleEnded  src -> load()                           (never applied)
 *   VideoPlayer route effect  src -> load()                           (back to 1.0)
 *
 * The React state (`playbackRate`) was never touched, which is why the UI kept
 * highlighting, e.g., 1.5x while the element actually played at 1.0x.
 *
 * The element behaviour was verified empirically in headless Chrome against a
 * real HTMLMediaElement before these tests were written:
 *
 *   rate set, then load()                 -> playbackRate 1    (reproduces the bug)
 *   defaultPlaybackRate + rate, then load -> playbackRate 1.5  (fix survives)
 *   bare `src =`, no explicit load()      -> playbackRate 1    (also runs the algorithm)
 *   volume/muted across load()            -> unchanged         (not the defect)
 *
 * There is no DOM test tooling in this repo, so the client behaviour is pinned
 * as source assertions, matching tests/settings-log-refresh.test.ts.
 */

const ROOT = process.cwd();

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

/** Strips comments so assertions cannot be satisfied by prose alone. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .map((line) => line.replace(/\s+\/\/.*$/, ''))
    .join('\n');
}

/** The `applyElementPlaybackRate` helper must write both attributes. */
const HELPER_SIGNATURE = /function applyElementPlaybackRate\(el: HTMLMediaElement \| null, rate: number\)/;
const HELPER_WRITES_DEFAULT = /el\.defaultPlaybackRate = rate;/;
const HELPER_WRITES_RATE = /el\.playbackRate = rate;/;

test('F1 — AudioContext keeps the chosen speed across load()', async (t) => {
  const code = stripComments(read('src/context/AudioContext.tsx'));

  /** A named slice of the file, ended by the next top-level declaration. */
  function slice(from: string, to: string): string {
    const start = code.indexOf(from);
    assert.ok(start >= 0, `slice anchor not found: ${from}`);
    const end = code.indexOf(to, start);
    assert.ok(end > start, `slice end not found: ${to}`);
    return code.slice(start, end);
  }

  await t.test('the applied rate is durable, not just the per-load attribute', () => {
    // Without `defaultPlaybackRate` the load algorithm overwrites the rate with
    // 1.0. This is the assertion that fails on the old code.
    assert.match(code, HELPER_SIGNATURE, 'the rate sender must be one shared helper');
    assert.match(code, HELPER_WRITES_DEFAULT, 'defaultPlaybackRate must be assigned');
    assert.match(code, HELPER_WRITES_RATE, 'playbackRate must still be assigned for the live stream');

    // The old bug was exactly this line: the value was written to `playbackRate`
    // only, and the `load()` on the next line threw it away.
    assert.doesNotMatch(
      code,
      /audioRef\.current\.playbackRate = playbackRate;/,
      'the direct assignment that load() discards must be gone'
    );
  });

  await t.test('playTrack applies the rate before the load that would reset it', () => {
    const playTrack = slice('const playTrack = useCallback', 'const togglePlay = useCallback');

    const applyAt = playTrack.indexOf(
      'applyElementPlaybackRate(audioRef.current, playbackRateRef.current);'
    );
    const loadAt = playTrack.indexOf('audioRef.current.load();');

    assert.ok(applyAt >= 0, 'playTrack must apply the rate to the element');
    assert.ok(loadAt >= 0, 'playTrack must still call load()');
    assert.ok(applyAt < loadAt, 'the rate must be applied before load(), which resets it');

    // The volume position across load() was verified to be fine (load does not
    // touch volume/muted) — it must not have been moved for the wrong reason.
    assert.match(playTrack, /applyElementVolume\(audioRef\.current, volume, isMuted\);/);
  });

  await t.test('handleEnded re-applies the rate on auto-advance', () => {
    const handleEnded = slice('const handleEnded = () => {', 'audio.addEventListener(');

    const applyAt = handleEnded.indexOf(
      'applyElementPlaybackRate(audioRef.current, playbackRateRef.current);'
    );
    const loadAt = handleEnded.indexOf('audioRef.current.load();');

    assert.ok(applyAt >= 0, 'the auto-advance path previously applied no rate at all');
    assert.ok(loadAt >= 0, 'handleEnded must still call load()');
    assert.ok(applyAt < loadAt, 'the rate must be applied before load()');
  });

  await t.test('setRate keeps defaultPlaybackRate in sync for a later reload', () => {
    const setRate = slice('const setRate = useCallback', 'const setVol = useCallback');

    // `setRate` wrote only `playbackRate`, so any later load() — including the
    // browser's own reload — started at 1.0x while the UI showed the choice.
    assert.match(
      setRate,
      /applyElementPlaybackRate\(audioRef\.current, rate\);/,
      'setRate must write the durable attribute too'
    );
    assert.doesNotMatch(
      setRate,
      /audioRef\.current\.playbackRate = rate;/,
      'setRate must not bypass the shared helper'
    );
  });

  await t.test('the element is seeded on creation and on mount restore', () => {
    const creation = slice('const audio = new Audio();', 'const handleTimeUpdate');
    assert.match(
      creation,
      /applyElementPlaybackRate\(audio, playbackRateRef\.current\);/,
      'the one-shot element must be seeded, or a reload starts at 1.0x'
    );

    // `setRate` is a no-op on the element until it exists, so a speed restored
    // before the first play has to be re-asserted once the element is there.
    const restore = slice("localStorage.getItem(STORAGE_KEY)", '}, []);');
    assert.match(
      restore,
      /applyElementPlaybackRate\(audioRef\.current, playbackRateRef\.current\);/,
      'the mount path must re-assert the chosen speed'
    );
  });

  await t.test('the one-shot effects read the rate through a ref, not a dependency', () => {
    const refAt = code.indexOf('const playbackRateRef = useRef<number>(playbackRate);');
    const effectAt = code.indexOf('playbackRateRef.current = playbackRate;');
    const elementAt = code.indexOf('const audio = new Audio();');

    assert.ok(refAt >= 0, 'a playbackRate ref must exist for the one-shot effects');
    assert.ok(effectAt >= 0, 'the ref must be kept up to date');
    // Declared before use: the element effect would otherwise read a TDZ binding.
    assert.ok(refAt < elementAt, 'the ref must be declared before the element effect');

    // Adding `playbackRate` to the element effect's dependency list would tear
    // the element (and its listeners) down on every speed change.
    const elementDeps = code.slice(elementAt, code.indexOf('const playTrack = useCallback'));
    assert.match(
      elementDeps,
      /\}, \[\]\);/,
      'the element-creation effect must stay one-shot'
    );
  });
});

test('F2 — VideoPlayer keeps the chosen speed across an episode change', async (t) => {
  const code = stripComments(read('src/components/VideoPlayer.tsx'));

  await t.test('the applied rate is durable, not just the per-load attribute', () => {
    assert.match(code, HELPER_SIGNATURE, 'the rate sender must be one shared helper');
    assert.match(code, HELPER_WRITES_DEFAULT, 'defaultPlaybackRate must be assigned');
    assert.match(code, HELPER_WRITES_RATE, 'playbackRate must still be assigned');
  });

  await t.test('the route effect re-applies the rate around its load()', () => {
    // Anchored on the code that follows the effect, because the effect's own
    // leading comment is stripped above.
    const route = code.slice(
      code.indexOf('let isMounted = true;\n    if (!currentProxyUrl) return;'),
      code.indexOf('// Dynamic Cache Status Polling for Current Video')
    );
    assert.ok(route.length > 0, 'the route effect must be locatable');

    const applyAt = route.indexOf(
      'applyElementPlaybackRate(videoRef.current, playbackRateRef.current);'
    );
    const loadAt = route.indexOf('videoRef.current.load();');

    assert.ok(applyAt >= 0, 'switching episodes assigned src+load() without re-applying the rate');
    assert.ok(loadAt >= 0, 'the route effect must still call load()');
    assert.ok(applyAt < loadAt, 'the rate must be applied before load()');

    // The ordering regression is only fixed if the next episode actually goes
    // through this branch, i.e. the src comparison is still there.
    assert.match(route, /if \(videoRef\.current\.getAttribute\('src'\) !== routeRes\.activeUrl\) \{/);
  });

  await t.test('the speed state reaches the element, and the ref is kept in sync', () => {
    // The speed button only sets React state; nothing else would reach the
    // element, so the sync effect must both update the ref and write the element.
    assert.match(
      code,
      /useEffect\(\(\) => \{\s*\n\s*playbackRateRef\.current = playbackRate;\s*\n\s*applyElementPlaybackRate\(videoRef\.current, playbackRate\);/
    );

    // `playbackRate` must NOT be a dependency of the route effect: that effect
    // starts the route probe, so keying it on the rate would re-probe the media
    // route on every speed click. The ref is what lets the rate reach the
    // element there without that cost.
    assert.match(
      code,
      /\}, \[currentTrackIndex, currentProxyUrl, currentSourceUrl\]\);/,
      'the route effect must stay keyed on the episode only'
    );
    // The proxy/source URLs are derived from `currentTrack`; depending on the
    // object itself would re-probe on every cache-status rebuild.
    assert.match(code, /const currentProxyUrl = currentTrack\?\.proxyUrl;/);
    assert.doesNotMatch(
      code,
      /videoRef\.current\.playbackRate = playbackRate;/,
      'the rate must always reach the element through the shared helper'
    );
  });
});

test('F3 — an out-of-range restored video index cannot blank the pane', async (t) => {
  const courseDetail = stripComments(read('src/components/CourseDetail.tsx'));

  await t.test('the restored index is clamped once the list length is known', () => {
    // The clamp condition is unchanged; the reset now goes through the helper
    // that owns the state setter, so a valid index is never silently dropped.
    assert.match(
      courseDetail,
      /if \(videoTracks\.length > 0 && currentVideoIndex >= videoTracks\.length\) \{/,
      'an index at or past videoTracks.length must be clamped'
    );
    assert.match(courseDetail, /handleVideoIndexChange\(0\);/, 'the clamp must reset to 0');
    assert.match(
      courseDetail,
      /const handleVideoIndexChange = \(idx: number\) => \{\s*\n\s*setCurrentVideoIndex\(idx\);/,
      'the reset must go through the state setter'
    );
  });

  await t.test('the clamped index is what reaches VideoPlayer', () => {
    assert.match(courseDetail, /const safeVideoIndex =/);
    const usages = courseDetail.match(/currentTrackIndex=\{safeVideoIndex\}/g) ?? [];
    assert.equal(usages.length, 2, 'both VideoPlayer mounts must use the clamped index');
    assert.doesNotMatch(
      courseDetail,
      /currentTrackIndex=\{currentVideoIndex\}/,
      'the raw index must not be handed to VideoPlayer'
    );
  });

  await t.test('VideoPlayer renders an empty state instead of nothing', () => {
    const player = stripComments(read('src/components/VideoPlayer.tsx'));
    // `tracks[currentTrackIndex]` is undefined for a stale index; the bare
    // `return null` removed the video, nav, dropdown and range tabs entirely.
    assert.doesNotMatch(player, /if \(!currentTrack\) return null;/);
    assert.match(
      player,
      /if \(!currentTrack\) \{[\s\S]{0,400}?className="no-audio-state"/,
      'the no-track branch must render a visible empty state'
    );
  });
});
