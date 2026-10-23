import './helpers/isolated-media-cache';

import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

/**
 * Regression tests for the whole-site bug / memory-leak audit.
 *
 * Each block pins one verified defect and the shape of its fix. The defects
 * were reproduced before being fixed:
 *
 *   1. list-files buffered the whole upstream body before enforcing its size
 *      cap, and its cache was bounded by entry count only (300 x 2 MB ≈ 600 MB
 *      reachable from an unauthenticated endpoint).
 *   2. serverMediaCache's download queue was unbounded (20k queued callers
 *      reproduced) and its slot handshake could run more transfers than the
 *      configured concurrency budget (peak 3 with a budget of 2).
 *   3. AudioContext.seekRelative coerced a not-yet-loaded `duration` (NaN) to 0,
 *      snapping playback to the start when the skip key was pressed early.
 *   4. VideoPlayer restarted a 3 s cache poll on tab-visible even for a file
 *      already cached.
 *   5. TreeNav trusted and re-persisted unvalidated localStorage content.
 */

const ROOT = process.cwd();

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

test('Whole-site leak hardening', async (t) => {
  await t.test('list-files bounds its cache by total bytes, not just entry count', () => {
    const src = read('src/app/api/list-files/route.ts');

    assert.match(src, /MAX_CACHE_BYTES/, 'a total-bytes ceiling must exist');
    assert.match(src, /let cacheBytes = 0;/, 'retained bytes must be tracked');

    // Every insert goes through putEntry and every removal through deleteEntry,
    // so the running total cannot drift out of sync with the map.
    assert.match(src, /function deleteEntry\(key: string\): void \{/);
    assert.match(src, /function putEntry\(key: string, entry: CacheEntry\): void \{/);

    // The eviction loop must consider both caps.
    assert.match(
      src,
      /while \(fileListCache\.size > MAX_CACHE_ITEMS \|\| cacheBytes > MAX_CACHE_BYTES\)/
    );

    // Expired entries are dropped on every sweep, not only when already over
    // the entry cap (the old code left stale-but-under-cap entries forever).
    assert.match(src, /if \(now - entry\.timestamp >= entry\.ttl\) deleteEntry\(key\);/);

    // No raw mutation may bypass the accounting.
    const rawSets = src.match(/fileListCache\.set\(/g) || [];
    assert.strictEqual(
      rawSets.length,
      2,
      'only the LRU promotion and putEntry may touch the map directly'
    );
  });

  await t.test('list-files enforces its size cap while streaming, not after', () => {
    const src = read('src/app/api/list-files/route.ts');

    // The reader must stop mid-transfer rather than calling res.text() first.
    assert.match(src, /const reader = res\.body\?\.getReader\(\);/);
    assert.match(src, /if \(total > MAX_RESPONSE_BYTES\) \{\s*\n\s*overflowed = true;/);

    // Cancelling releases the upstream socket instead of draining the rest.
    assert.match(src, /if \(overflowed\) \{[\s\S]{0,200}await reader\.cancel\(\);/);

    // A declared Content-Length over the cap is rejected without reading at all.
    assert.match(src, /content-length/);
    assert.match(src, /declaredLength > MAX_RESPONSE_BYTES/);

    // The constants the guards depend on must still be defined.
    assert.match(src, /const MAX_RESPONSE_BYTES = 2 \* 1024 \* 1024;/);
    assert.match(src, /const UPSTREAM_TIMEOUT_MS = 15000;/);
  });

  await t.test('media cache queue is bounded and refuses overflow', () => {
    const src = read('src/lib/serverMediaCache.ts');

    assert.match(src, /const MAX_QUEUED_DOWNLOADS = Math\.max\(/);
    assert.match(
      src,
      /if \(downloadQueue\.length >= MAX_QUEUED_DOWNLOADS\) \{\s*\n\s*return false;/,
      'overflow must be refused rather than queued'
    );
    assert.match(
      src,
      /const acquired = await acquireDownloadSlot\(\);\s*\n\s*if \(!acquired\) \{/,
      'the caller must handle a refusal'
    );
    assert.match(
      src,
      /activeDownloads\.delete\(cacheFilePath\);\s*\n\s*return;/,
      'a refused download must not stay registered as in-flight'
    );
  });

  await t.test('media cache slot handoff never over-subscribes the budget', () => {
    const src = read('src/lib/serverMediaCache.ts');

    const acquire = src.slice(src.indexOf('async function acquireDownloadSlot'));
    const release = src.slice(src.indexOf('function releaseDownloadSlot'));
    const releaseBody = release.slice(0, release.indexOf('\n}'));

    // Direct handoff: the woken waiter keeps the slot, so the slot counter must
    // NOT be decremented before waking it (that was the over-subscription bug).
    assert.match(
      releaseBody,
      /const next = downloadQueue\.shift\(\);\s*\n\s*if \(next\) \{[\s\S]{0,120}next\(\);\s*\n\s*return;/,
      'the slot must be transferred, not freed then re-acquired'
    );
    assert.match(releaseBody, /if \(slotsInUse > 0\) slotsInUse--;/, 'the free path still decrements');

    // The resumed waiter must not increment again.
    const afterPush = acquire.slice(acquire.indexOf('downloadQueue.push(resolve)'));
    assert.doesNotMatch(
      afterPush,
      /slotsInUse\+\+/,
      'the woken waiter must not re-increment the slot it was handed'
    );
    assert.match(acquire, /async function acquireDownloadSlot\(\): Promise<boolean>/);
  });

  await t.test('queue helpers still expose observable counts', () => {
    const src = read('src/lib/serverMediaCache.ts');
    assert.match(src, /export function getQueuedDownloadCount\(\): number \{\s*\n\s*return downloadQueue\.length;/);
    assert.match(src, /export function getMaxConcurrentDownloads\(\): number \{/);
  });

  await t.test('seekRelative clamps against a finite duration only', () => {
    const src = read('src/context/AudioContext.tsx');

    assert.match(src, /Number\.isFinite\(duration\) && duration > 0 \? duration : Infinity/);
    assert.doesNotMatch(
      src,
      /Math\.min\(audioRef\.current\.duration \|\| 0/,
      'the NaN-coercing clamp must be gone'
    );
  });

  await t.test('VideoPlayer does not restart polling for an already-cached file', () => {
    const src = read('src/components/VideoPlayer.tsx');

    assert.match(
      src,
      /const handleVisibility = \(\) => \{\s*\n\s*if \(document\.hidden\) stopPolling\(\);\s*\n\s*else if \(!isServerCached\) startPolling\(\);/,
      'the visible branch must re-check the cached flag'
    );
    assert.doesNotMatch(
      src,
      /if \(document\.hidden\) stopPolling\(\);\s*\n\s*else startPolling\(\);/,
      'the unguarded restart must be gone'
    );
  });

  await t.test('recent-course ids are validated and bounded', () => {
    // The logic moved out of TreeNav into a store shared by the reader and the
    // writer, so the invariants are asserted where they now live.
    const store = read('src/lib/recentCourses.ts');

    assert.match(store, /export const MAX_RECENT_COURSES = 4;/);
    assert.match(store, /typeof id === 'number' && Number\.isFinite\(id\)/);
    assert.match(store, /\.slice\(0, MAX_RECENT_COURSES\)/);
    // The writer uses the same bound, so reader and writer cannot diverge.
    assert.doesNotMatch(store, /\.slice\(0, 4\)/);

    // TreeNav must consume the store rather than re-implementing the rules.
    const src = read('src/components/TreeNav.tsx');
    assert.match(src, /getRecentCoursesSnapshot/);
    assert.doesNotMatch(src, /const MAX_RECENT_COURSES = 4;/);
  });

  await t.test('TreeNav audio pill tests audio_path, and search covers branch titles', () => {
    const src = read('src/components/TreeNav.tsx');

    // `total_episodes === 0` matched no catalog row, so 音訊 showed all 684 rows
    // while 161 courses have no audio at all.
    assert.match(src, /if \(mediaFilter === 'audio' && !course\.audio_path\) return;/);
    assert.doesNotMatch(src, /mediaFilter === 'audio' && course\.total_episodes === 0/);

    // Visible branch labels must be searchable (they are rendered on screen),
    // and a multi-term query must narrow the result set rather than widen it.
    assert.match(src, /course\.main_menu_title,/, 'main menu label must be in the haystack');
    assert.match(src, /course\.sub_menu_title,/, 'sub menu label must be in the haystack');
    assert.match(src, /course\.topic_title,/, 'topic label must be in the haystack');
    assert.match(
      src,
      /if \(!terms\.every\(\(term\) => haystack\.includes\(term\)\)\) \{/,
      'every search term must match (AND), not any one of them (OR)'
    );
    assert.match(
      src,
      /\.\.\.\(course\.pdfs \|\| \[\]\)\.map\(\(p\) => p\.filename\)/,
      'lecture-note filenames must be searchable'
    );
  });

  await t.test('page.tsx fetchCourses has a stable identity and validates rows', () => {
    const src = read('src/app/page.tsx');

    // The self-retriggering loop: the callback must not depend on courses.length.
    assert.match(src, /const hasCoursesRef = useRef<boolean>\(initialCourses\.length > 0\);/);
    assert.match(src, /if \(!hasCoursesRef\.current\) \{/);
    assert.doesNotMatch(src, /\}, \[courses\.length\]\);/, 'the length-keyed callback must be gone');

    // Rows are validated at the network boundary before entering state.
    assert.match(src, /const isCourseRow = \(c: unknown\): c is CourseItem => \{/);
    assert.match(src, /typeof row\.id === 'number' &&/, 'id must be a finite number');
    assert.match(src, /typeof row\.name === 'string'/, 'name must be a string');
  });

  await t.test('HomePortal pickers guard name access and rank by substance', () => {
    const src = read('src/components/HomePortal.tsx');

    // Unguarded `c.name.includes` threw on one malformed row.
    assert.doesNotMatch(src, /c\.name\.includes\(/);
    assert.match(src, /\(c\.name \|\| ''\)\.includes\(/);

    // Flagship selection must not be "first in catalog order".
    assert.match(src, /const pickFlagship = useCallback\(/);
    assert.match(src, /\(b\.total_episodes \|\| 0\) - \(a\.total_episodes \|\| 0\)/);
    assert.match(src, /const yogaCourse = useMemo\(\s*\n\s*\(\) => pickFlagship\('瑜伽師地論'\)/);
  });

  await t.test('HomePortal does not double the 年 suffix', () => {
    const src = read('src/components/HomePortal.tsx');
    // 10 rows already carry 年; appending unconditionally rendered "1997年 年".
    assert.match(src, /\/年\/\.test\(String\(course\.time\)\) \? course\.time : `\$\{course\.time\} 年`/);
  });

  await t.test('media cache releases the upstream body on the error path', () => {
    const src = read('src/lib/serverMediaCache.ts');

    // `upstream = res.body` must precede the !res.ok early return, otherwise
    // discardUpstream() (which returns on null) is dead on that exact path.
    const fetchIdx = src.indexOf('const res = await fetch(targetUrl');
    const assignIdx = src.indexOf('upstream = res.body;', fetchIdx);
    const okCheckIdx = src.indexOf('if (!res.ok || !res.body)', fetchIdx);
    assert.ok(fetchIdx > 0 && assignIdx > 0 && okCheckIdx > 0, 'all three sites must exist');
    assert.ok(
      assignIdx < okCheckIdx,
      'upstream must be assigned before the !res.ok early return'
    );
  });

  await t.test('media cache removes a partially-committed file on failure', () => {
    const src = read('src/lib/serverMediaCache.ts');

    assert.match(src, /let committed = false;/);
    assert.match(src, /committed = true;/, 'the post-rename window must be marked');
    assert.match(src, /if \(committed\) \{[\s\S]{0,300}await fs\.promises\.unlink\(cacheFilePath\);/);
  });

  await t.test('LRU never evicts in-flight reads or foreign files', () => {
    const src = read('src/lib/serverMediaCache.ts');

    assert.match(src, /const CACHE_FILENAME_RE = \/\^\[0-9a-f\]\{32\}/);
    // A Set, not a flag: two concurrent readers of one file must each hold a
    // pin, so the last one out clears it. A Set let the first reader's release
    // drop the pin for both, and LRU then evicted a file still being streamed.
    assert.match(src, /const filesInUse = new Map<string, number>\(\);/);
    assert.match(src, /export function markCacheFileInUse\(filePath: string\): \(\) => void \{/);
    assert.match(src, /if \(filesInUse\.has\(fullPath\)\) continue;/);
    assert.match(src, /if \(!CACHE_FILENAME_RE\.test\(filename\)\) continue;/);
    assert.match(src, /if \(evictedAny\) invalidateCacheStats\(\);/);
    // Stats must use the same contract as eviction.
    assert.match(src, /if \(!file\.endsWith\('\.tmp'\) && CACHE_FILENAME_RE\.test\(file\)\)/);
  });

  await t.test('proxy release of cached read handles is declared', () => {
    const src = read('src/app/api/proxy/route.ts');

    assert.match(src, /markCacheFileInUse/);
    assert.match(src, /fileStream\.once\('close', releaseInUse\);/);
    assert.match(src, /fileStream\.once\('error', releaseInUse\);/);
  });

  await t.test('speedTester releases the probe body on non-ok responses', () => {
    const src = read('src/lib/speedTester.ts');
    assert.match(src, /await res\.body\?\.cancel\(\)\.catch\(\(\) => \{\}\);/);
  });

  await t.test('AudioContext guards async continuations and finite time values', () => {
    const src = read('src/context/AudioContext.tsx');

    // Continuations must bail after unmount, not only on a stale request id.
    assert.match(src, /const isMountedRef = useRef<boolean>\(true\);/);
    assert.match(src, /if \(!isMountedRef\.current \|\| reqId !== playRequestIdRef\.current\) return;/);

    // NaN currentTime/duration must not reach the UI.
    assert.match(src, /setCurrentTime\(Number\.isFinite\(time\) \? time : 0\);/);
    assert.match(src, /setDuration\(Number\.isFinite\(dur\) && dur > 0 \? dur : 0\);/);

    // playTrack must preserve the caller's index and resolve by index value.
    assert.match(src, /index: typeof t\.index === 'number' \? t\.index : idx/);
    assert.match(src, /formattedPlaylist\.find\(\(t\) => t\.index === trackIndex\) \?\? formattedPlaylist\[trackIndex\]/);

    // Volume and mute are applied from one place.
    assert.match(src, /const applyElementVolume = useCallback/);
    assert.match(src, /applyElementVolume\(audioRef\.current, volume, isMuted\)/);
  });

  await t.test('PdfViewer supports Escape and does not reset on list refresh', () => {
    const src = read('src/components/PdfViewer.tsx');
    assert.match(src, /if \(e\.key === 'Escape'\) setIsFullscreen\(false\);/);
    assert.match(src, /window\.addEventListener\('keydown', handleKeyDown\);/);
    assert.match(src, /window\.removeEventListener\('keydown', handleKeyDown\);/);
    assert.match(src, /const lastCourseRef = useRef\(courseTitle\);/);
    assert.doesNotMatch(src, /setSelectedPdfIndex\(0\);\s*\n\s*\}, \[courseTitle, pdfs\]\);/);
  });

  await t.test('GlobalAudioPlayer ignores shortcuts inside iframes', () => {
    const src = read('src/components/GlobalAudioPlayer.tsx');
    assert.match(src, /if \(activeTag === 'iframe' \|\| active\?\.isContentEditable\) \{/);
  });

  await t.test('page.tsx preserves the selected course identity across refreshes', () => {
    const src = read('src/app/page.tsx');

    // Returning the freshly parsed row unconditionally gave CourseDetail a new
    // `course` object on every refresh, re-running its discovery requests.
    assert.match(src, /function shallowEqualCourse\(a: CourseItem, b: CourseItem\): boolean \{/);
    assert.match(src, /return shallowEqualCourse\(prevSelected, updated\) \? prevSelected : updated;/);
    assert.match(src, /if \(!updated\) return prevSelected;/);
    // pdfs are compared by content, since a new array is always produced.
    assert.match(src, /if \(ap\[i\]\?\.url !== bp\[i\]\?\.url \|\| ap\[i\]\?\.filename !== bp\[i\]\?\.filename\) return false;/);
  });

  await t.test('CourseDetail scopes 本地分 discovery to the course volume', () => {
    // The volume-scoping helper now lives in a plain module, so assert against
    // it directly instead of regexing the component.
    const helper = read('src/lib/courseMedia.ts');

    // The shared-root fallback over-attributed files to every volume page.
    assert.match(helper, /export const sharedRootDirFor = \(course: CourseItem\): string \| undefined =>/);
    assert.doesNotMatch(
      helper,
      /course\.name\.includes\('本地分'\) \? '\/media\/釋論\/瑜伽師地論・本地分' : undefined/
    );

    // The course name decides the volume; the full token must be captured so
    // real directories like 卷12至13-1 are not truncated to 卷12.
    assert.match(helper, /const vols = name\.match\(\/卷\[0-9０-９\]\+/);
    assert.match(helper, /if \(vols && vols\.length === 1\) \{/);
    assert.match(helper, /if \(!\/卷\/\.test\(name\)\) \{/);

    // The discovery logic itself now lives in the PDF hook.
    const pdfHook = read('src/lib/usePdfTracks.ts');
    assert.match(pdfHook, /const scoped = sharedRootDirFor\(course\)/);

    const src = read('src/components/CourseDetail.tsx');

    // The loading label must not equate "empty" with "loading".
    assert.match(src, /isLoadingVideo \? '載入中' : videoTracks\.length/);
    assert.doesNotMatch(src, /videoTracks\.length \|\| '載入中'/);
  });
});
