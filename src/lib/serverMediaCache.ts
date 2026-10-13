import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Readable, Transform } from 'stream';

export function getCacheDir(): string {
  const envDir = process.env.MEDIA_CACHE_DIR;
  if (envDir && envDir.includes('data')) {
    return envDir;
  }
  return path.join(/*turbopackIgnore: true*/ process.cwd(), 'data', 'media_cache');
}

export function ensureCacheDir(): string {
  const cacheDir = getCacheDir();
  try {
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
  } catch {}
  return cacheDir;
}

const MAX_CACHE_SIZE_BYTES = parseInt(process.env.MEDIA_CACHE_MAX_BYTES || '', 10) || 20 * 1024 * 1024 * 1024; // 20 GB default limit
const TARGET_CACHE_SIZE_BYTES = parseInt(process.env.MEDIA_CACHE_TARGET_BYTES || '', 10) || Math.floor(MAX_CACHE_SIZE_BYTES * 0.85); // 17 GB High-water mark after eviction (85%)

export interface CacheStats {
  currentBytes: number;
  maxBytes: number;
  fileCount: number;
  maxGb: number;
}

/**
 * Memoized cache stats.
 *
 * Measuring the cache means stat()ing every file, and the media cache can hold
 * tens of thousands of entries. The scan route polls this while a maintenance
 * job runs, so an unmemoized scan blocked the event loop for hundreds of
 * milliseconds per poll. A few seconds of staleness is irrelevant for a disk
 * usage figure.
 */
const STATS_TTL_MS = 5000;
let statsMemo: { at: number; value: CacheStats } | null = null;

/** Invalidates the memo after an operation that changes the cache contents. */export function invalidateCacheStats(): void {
  statsMemo = null;
}

/**
 * Computes cache usage without blocking the event loop.
 *
 * Uses async I/O so a large directory scan interleaves with request handling
 * instead of stalling the server.
 */
export async function getCacheStatsAsync(): Promise<CacheStats> {
  const now = Date.now();
  if (statsMemo && now - statsMemo.at < STATS_TTL_MS) return statsMemo.value;

  const cacheDir = getCacheDir();
  let currentBytes = 0;
  let fileCount = 0;
  try {
    const files = await fs.promises.readdir(cacheDir);
    // Stat in bounded batches so a huge cache does not open thousands of
    // descriptors or starve the event loop.
    const BATCH = 64;
    for (let i = 0; i < files.length; i += BATCH) {
      await Promise.all(
        files.slice(i, i + BATCH).map(async (file) => {
          if (file.endsWith('.tmp')) return;
          try {
            const stat = await fs.promises.stat(path.join(cacheDir, file));
            if (stat.isFile()) {
              currentBytes += stat.size;
              fileCount++;
            }
          } catch {}
        })
      );
    }
  } catch {
    // A missing/unreadable directory reports as empty rather than throwing.
  }

  const value: CacheStats = {
    currentBytes,
    maxBytes: MAX_CACHE_SIZE_BYTES,
    maxGb: Math.round(MAX_CACHE_SIZE_BYTES / (1024 * 1024 * 1024)),
    fileCount
  };
  statsMemo = { at: now, value };
  return value;
}

/**
 * Synchronous variant, retained for tests and non-hot paths.
 *
 * Returns the memoized value when fresh; otherwise performs a blocking scan.
 * Hot paths should prefer `getCacheStatsAsync`.
 */
export function getCacheStats(): CacheStats {
  const now = Date.now();
  if (statsMemo && now - statsMemo.at < STATS_TTL_MS) return statsMemo.value;

  const cacheDir = getCacheDir();
  let currentBytes = 0;
  let fileCount = 0;
  try {
    if (fs.existsSync(cacheDir)) {
      const files = fs.readdirSync(cacheDir);
      for (const file of files) {
        if (!file.endsWith('.tmp')) {
          try {
            const stat = fs.statSync(path.join(cacheDir, file));
            if (stat.isFile()) {
              currentBytes += stat.size;
              fileCount++;
            }
          } catch {}
        }
      }
    }
  } catch {}
  const value: CacheStats = {
    currentBytes,
    maxBytes: MAX_CACHE_SIZE_BYTES,
    maxGb: Math.round(MAX_CACHE_SIZE_BYTES / (1024 * 1024 * 1024)),
    fileCount
  };
  statsMemo = { at: now, value };
  return value;
}

export function getCacheKey(targetUrlOrPath: string): string {
  return crypto.createHash('md5').update(targetUrlOrPath).digest('hex');
}

export function getCacheFilePath(targetUrlOrPath: string, ext: string): string {
  const hash = getCacheKey(targetUrlOrPath);
  const rawExt = (ext || '').split('?')[0].replace(/^\./, '');
  const cleanExt = rawExt && /^[a-zA-Z0-9]+$/.test(rawExt) ? `.${rawExt}` : '.media';
  return path.join(ensureCacheDir(), `${hash}${cleanExt}`);
}

export function isCached(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

/**
 * Records a cache read for LRU purposes.
 *
 * IMPORTANT: this deliberately sets a new *atime* while preserving the existing
 * *mtime*. The previous implementation wrote `now` into both fields, which made
 * atime and mtime indistinguishable. Because a freshly downloaded file is only
 * "touched" when it is actually played, that collapse inverted the eviction
 * order: files that had never been requested kept their old timestamps and were
 * evicted first, while recently created files survived. Keeping mtime intact
 * lets the LRU sort use atime purely as "last read" and mtime as a stable
 * tiebreaker.
 */
export function updateAccessTime(filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    const now = new Date();
    fs.utimesSync(filePath, now, stat.mtime);
  } catch (e) {
    console.warn('Failed to update file access time:', e);
  }
}

/** Temp paths with a download currently in flight; never reclaimed as "stale". */
const activeTempPaths = new Set<string>();

/**
 * Removes every temporary (.tmp) file, unconditionally.
 *
 * Safe only during process startup: at that moment no download can be in
 * flight, so every `.tmp` file is by definition an orphan from a previous
 * process. `cleanStaleTempFiles` cannot serve this purpose because it
 * deliberately skips files younger than 3 minutes — which, right after a
 * restart, is all of them.
 */
export async function cleanAllTempFiles(): Promise<number> {
  const cacheDir = getCacheDir();
  let removed = 0;
  try {
    const files = await fs.promises.readdir(cacheDir);
    for (const filename of files) {
      if (!filename.endsWith('.tmp')) continue;
      const fullPath = path.join(cacheDir, filename);
      if (activeTempPaths.has(fullPath)) continue;
      try {
        await fs.promises.unlink(fullPath);
        removed++;
      } catch {}
    }
    if (removed > 0) {
      console.log(`[Media Cache] Cleared ${removed} orphaned temp file(s) at startup.`);
      invalidateCacheStats();
    }
  } catch {
    // A missing or unreadable cache directory is not an error here.
  }
  return removed;
}

/**
 * Removes any stale temporary (.tmp) files left behind by interrupted downloads.
 *
 * Files with an in-flight download are skipped so that a slow multi-minute
 * transfer (large video on a poor link) is not deleted out from under itself by
 * a concurrent LRU pass.
 */
export async function cleanStaleTempFiles(): Promise<void> {
  const cacheDir = getCacheDir();
  try {
    if (!fs.existsSync(cacheDir)) return;
    const files = await fs.promises.readdir(cacheDir);
    const now = Date.now();
    for (const filename of files) {
      if (filename.endsWith('.tmp')) {
        const fullPath = path.join(cacheDir, filename);
        if (activeTempPaths.has(fullPath)) continue; // Download in progress
        try {
          const stat = await fs.promises.stat(fullPath);
          // Delete .tmp files older than 3 minutes
          if (now - stat.mtimeMs > 3 * 60 * 1000) {
            await fs.promises.unlink(fullPath);
            console.log(`[Media Cache] Removed stale temporary file: ${filename}`);
          }
        } catch {}
      }
    }
  } catch (e) {
    console.warn('[Media Cache] Stale temp file cleanup error:', e);
  }
}

/** Guards against overlapping LRU passes evicting the same entries twice. */
let lruRunning: Promise<void> | null = null;

/**
 * Enforces LRU Eviction Limit on Server Cache Directory.
 * Concurrent callers share a single in-flight pass.
 */
export async function enforceLRULimit(): Promise<void> {
  if (lruRunning) return lruRunning;
  lruRunning = runLRUPass().finally(() => {
    lruRunning = null;
  });
  return lruRunning;
}

async function runLRUPass(): Promise<void> {
  const cacheDir = getCacheDir();
  try {
    if (!fs.existsSync(cacheDir)) return;

    await cleanStaleTempFiles();

    const files = await fs.promises.readdir(cacheDir);
    let totalSize = 0;

    const fileStats: { filePath: string; size: number; atimeMs: number; mtimeMs: number }[] = [];

    for (const filename of files) {
      if (filename.endsWith('.tmp')) continue; // Exclude active temp files from LRU size
      const fullPath = path.join(cacheDir, filename);
      if (activeTempPaths.has(fullPath)) continue;
      try {
        const stat = await fs.promises.stat(fullPath);
        if (stat.isFile()) {
          totalSize += stat.size;
          fileStats.push({
            filePath: fullPath,
            size: stat.size,
            atimeMs: stat.atimeMs,
            mtimeMs: stat.mtimeMs
          });
        }
      } catch {
        // ignore missing stats
      }
    }

    if (totalSize <= MAX_CACHE_SIZE_BYTES) {
      return; // Under size limit, no action needed
    }

    const maxGb = (MAX_CACHE_SIZE_BYTES / (1024 * 1024 * 1024)).toFixed(2);
    console.log(`[Media Cache LRU] Total cache size (${(totalSize / 1024 / 1024 / 1024).toFixed(2)} GB) exceeds ${maxGb} GB limit. Evicting oldest files...`);

    // Sort by last-read time ascending (least recently used first).
    // mtime breaks ties deterministically for files never read since creation.
    fileStats.sort((a, b) => a.atimeMs - b.atimeMs || a.mtimeMs - b.mtimeMs);

    for (const item of fileStats) {
      if (totalSize <= TARGET_CACHE_SIZE_BYTES) break;
      try {
        await fs.promises.unlink(item.filePath);
        totalSize -= item.size;
        console.log(`[Media Cache LRU] Evicted: ${path.basename(item.filePath)} (${(item.size / 1024 / 1024).toFixed(2)} MB)`);
      } catch (e) {
        console.warn(`[Media Cache LRU] Failed to delete file ${item.filePath}:`, e);
      }
    }

    console.log(`[Media Cache LRU] Eviction finished. Current cache size: ${(totalSize / 1024 / 1024 / 1024).toFixed(2)} GB`);
  } catch (e) {
    console.warn('[Media Cache LRU] Error during cache cleanup:', e);
  }
}

/**
 * Debounced LRU trigger. Download completions call this instead of invoking a
 * full directory scan on every single file, so a burst of downloads produces at
 * most one eviction pass per interval.
 */
const LRU_DEBOUNCE_MS = parseInt(process.env.MEDIA_CACHE_LRU_DEBOUNCE_MS || '', 10) || 30 * 1000;
let lruTimer: NodeJS.Timeout | null = null;

export function scheduleLRUEnforcement(): void {
  if (lruTimer) return;
  lruTimer = setTimeout(() => {
    lruTimer = null;
    void enforceLRULimit();
  }, LRU_DEBOUNCE_MS);
  // Do not keep the process alive purely on account of a pending eviction pass.
  if (typeof lruTimer.unref === 'function') {
    lruTimer.unref();
  }
}

/**
 * Periodic maintenance: temp cleanup plus LRU enforcement.
 *
 * Eviction was previously reachable *only* from `scheduleLRUEnforcement`, which
 * runs after a download completes successfully. That is circular when the disk
 * is the problem: once the volume fills, writes start failing, so no download
 * ever completes, so no eviction pass ever runs and the cache stays pinned over
 * budget. A timer breaks that cycle, and also clears `.tmp` orphans left by a
 * restart without waiting for someone to request the same media again.
 */
const MAINTENANCE_INTERVAL_MS = Math.max(
  30_000,
  parseInt(process.env.MEDIA_CACHE_MAINTENANCE_INTERVAL_MS || '', 10) || 10 * 60 * 1000
);

let maintenanceTimer: NodeJS.Timeout | null = null;

export function startCacheMaintenance(): void {
  if (maintenanceTimer) return;
  maintenanceTimer = setInterval(() => {
    void enforceLRULimit();
  }, MAINTENANCE_INTERVAL_MS);
  if (typeof maintenanceTimer.unref === 'function') {
    maintenanceTimer.unref();
  }
  console.log(`[Media Cache] Maintenance sweep every ${Math.round(MAINTENANCE_INTERVAL_MS / 1000)}s.`);
}

// Map to prevent duplicate concurrent background downloads for the same target file
const activeDownloads = new Map<string, Promise<void>>();

/** FIFO queue of waiters when the download concurrency budget is exhausted. */
const downloadQueue: (() => void)[] = [];

/**
 * Number of downloads currently holding a transfer slot.
 *
 * This is deliberately separate from `activeDownloads.size`: that map is
 * populated synchronously so duplicate requests for the same file can be
 * deduplicated, which means it also counts queued (not yet transferring) work.
 * Only this counter reflects real concurrency.
 */
let slotsInUse = 0;

/**
 * Upper bound on simultaneous background downloads.
 *
 * Without this, an unauthenticated caller could issue thousands of distinct
 * `action=preload` requests and have the server pull every one of them at once,
 * saturating bandwidth and disk I/O until the 20 GB cache ceiling was reached.
 */
const MAX_CONCURRENT_DOWNLOADS = Math.max(
  1,
  parseInt(process.env.MEDIA_CACHE_MAX_CONCURRENCY || '', 10) || 3
);

/**
 * Upper bound for a cacheable asset (0 disables the check). Defaults to 4 GB.
 *
 * Read lazily on each use so tests (and a restarted process with different
 * configuration) observe the current value rather than an import-time snapshot.
 */
let maxCacheableBytesOverride: number | null = null;

function getMaxCacheableBytes(): number {
  if (maxCacheableBytesOverride !== null) return maxCacheableBytesOverride;
  return parseInt(process.env.MEDIA_CACHE_MAX_FILE_BYTES || '', 10) || 4 * 1024 * 1024 * 1024;
}

/** Test hook: pins the per-file ceiling without re-importing the module. */
export function setMaxCacheableBytesForTest(bytes: number | null): void {
  maxCacheableBytesOverride = bytes;
}

/** Acquires a download slot, awaiting a free one when the budget is full. */
async function acquireDownloadSlot(): Promise<void> {
  if (slotsInUse < MAX_CONCURRENT_DOWNLOADS) {
    slotsInUse++;
    return;
  }
  await new Promise<void>((resolve) => downloadQueue.push(resolve));
  slotsInUse++;
}

/** Releases a download slot and wakes the next waiter, if any. */
function releaseDownloadSlot(): void {
  if (slotsInUse > 0) slotsInUse--;
  const next = downloadQueue.shift();
  if (next) next();
}


/**
 * Detects an HTML/SPA error page that the origin served with HTTP 200.
 * fayun.org answers unknown paths with a 200 HTML shell, so trusting the status
 * code alone would persist a 2KB HTML document as `*.mp3` and then report it as
 * "cached" forever.
 */
function looksLikeHtmlContentType(contentType: string | null): boolean {
  const ct = (contentType || '').toLowerCase();
  return ct.includes('text/html') || ct.includes('application/xhtml');
}

export async function fileLooksLikeHtml(filePath: string): Promise<boolean> {
  try {
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(512);
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      const head = buf.subarray(0, bytesRead).toString('utf-8').trimStart().toLowerCase();
      return head.startsWith('<!doctype html') || head.startsWith('<html');
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

/**
 * Downloads remote media file to server cache disk in background and renames it to a formal file upon completion
 */
export async function cacheRemoteMedia(targetUrl: string, cacheFilePath: string): Promise<void> {
  const tempPath = `${cacheFilePath}.tmp`;

  if (isCached(cacheFilePath)) {
    return;
  }

  // Return existing in-flight background download if already running
  const inFlight = activeDownloads.get(cacheFilePath);
  if (inFlight) {
    return inFlight;
  }

  // A leftover .tmp is only evidence of an active download when *this* process
  // is actually transferring into it. The previous implementation trusted a
  // fresh mtime, so a .tmp orphaned by a restart (or a crash) made every
  // subsequent request return early for up to 5 minutes: nothing downloaded,
  // nothing was cached, and playback kept hitting the origin.
  if (fs.existsSync(tempPath)) {
    if (activeTempPaths.has(tempPath)) {
      return; // A download owned by this process is genuinely in flight.
    }
    try {
      fs.unlinkSync(tempPath); // Orphan from a previous process: reclaim it.
      console.warn(`[Media Cache] Removed orphaned temp file: ${path.basename(tempPath)}`);
    } catch {}
  }

  const downloadPromise = (async () => {
    // Reserve a slot BEFORE registering, so activeDownloads only ever contains
    // downloads that are actually transferring. Callers queue instead of
    // stampeding the origin when the budget is exhausted.
    await acquireDownloadSlot();
    activeTempPaths.add(tempPath);

    /**
     * Releases the upstream body.
     *
     * Every early return below used to abandon `res.body` without consuming or
     * cancelling it, leaving the underlying socket and its buffers alive until
     * GC happened to run. Repeated rejections pinned connections and memory.
     */
    let upstream: ReadableStream<Uint8Array> | null = null;
    const discardUpstream = async () => {
      if (!upstream) return;
      try {
        await upstream.cancel();
      } catch {}
      upstream = null;
    };

    try {
      console.log(`[Media Cache] Starting full background download for formal file: ${path.basename(cacheFilePath)}`);

      const cleanHeaders: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.fayun.org/',
        'Accept': '*/*'
      };

      const res = await fetch(targetUrl, {
        headers: cleanHeaders,
        cache: 'no-store'
      });

      if (!res.ok || !res.body) {
        console.warn(`[Media Cache] Failed to fetch remote file ${targetUrl}: HTTP ${res.status}`);
        await discardUpstream();
        return;
      }
      upstream = res.body;

      // Reject HTML/SPA error pages served with a 200 status before writing anything.
      if (looksLikeHtmlContentType(res.headers.get('content-type'))) {
        console.warn(`[Media Cache] Refusing to cache HTML document for ${targetUrl} (content-type: ${res.headers.get('content-type')})`);
        await discardUpstream();
        return;
      }

      const contentLengthStr = res.headers.get('content-length');
      const expectedSize = contentLengthStr ? parseInt(contentLengthStr, 10) : 0;

      const maxCacheable = getMaxCacheableBytes();
      if (maxCacheable > 0 && expectedSize > maxCacheable) {
        console.warn(`[Media Cache] Skipping oversized asset (${expectedSize} bytes) for ${targetUrl}`);
        await discardUpstream();
        return;
      }

      const fileStream = fs.createWriteStream(tempPath);
      const nodeStream = Readable.fromWeb(res.body as any);

      /**
       * Enforces the size ceiling while streaming.
       *
       * The header check above is skipped entirely when the origin omits
       * `Content-Length`, which meant a chunked (or hostile) response of any
       * size was written to disk until it finished. This caps the bytes
       * actually persisted.
       */
      let written = 0;
      let tooLarge = false;
      const limiter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          written += chunk.length;
          if (maxCacheable > 0 && written > maxCacheable) {
            tooLarge = true;
            cb(new Error(`exceeds per-file cache ceiling (${maxCacheable})`));
            return;
          }
          cb(null, chunk);
        }
      });

      let streamError: Error | null = null;

      /**
       * Waits for the write stream to *close*, not merely to error.
       *
       * `createWriteStream` opens its descriptor asynchronously. Resolving as
       * soon as an error arrived meant cleanup could unlink the temp path
       * before the stream had opened it — and the pending open then recreated
       * the file, leaving residue that no later sweep would attribute to a
       * failed download. Waiting for 'close' guarantees the descriptor is
       * released and no further writes can land.
       */
      await new Promise<void>((resolve) => {
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          resolve();
        };

        const fail = (err: Error) => {
          streamError = streamError || err;
          // Tear the pipeline down so 'close' fires promptly. Without this the
          // file stream would keep waiting for data that will never arrive.
          nodeStream.destroy();
          limiter.destroy();
          fileStream.destroy();
        };

        nodeStream.on('error', fail);
        limiter.on('error', fail);
        fileStream.on('error', fail);
        fileStream.on('close', settle);

        nodeStream.pipe(limiter).pipe(fileStream);
      });

      if (tooLarge) {
        console.warn(`[Media Cache] Aborted oversized stream for ${targetUrl} after ${written} bytes`);
        return;
      }
      if (streamError) {
        const msg = (streamError as Error).message;
        console.warn(`[Media Cache] Stream failed for ${path.basename(cacheFilePath)}: ${msg}`);
        return;
      }

      if (isCached(cacheFilePath)) {
        return;
      }

      if (fs.existsSync(tempPath)) {
        const stat = await fs.promises.stat(tempPath);
        // When the origin declares a length, require the whole body. Without
        // one, the only available signal is that the stream ended cleanly.
        const sizeOk = stat.size > 0 && (expectedSize === 0 || stat.size >= expectedSize);
        if (sizeOk) {
          // Second line of defence: the origin may omit or lie about content-type.
          if (await fileLooksLikeHtml(tempPath)) {
            console.warn(`[Media Cache] Discarding HTML-shaped payload for ${path.basename(cacheFilePath)}`);
            return;
          }
          await fs.promises.rename(tempPath, cacheFilePath);
          updateAccessTime(cacheFilePath);
          invalidateCacheStats();
          console.log(`[Media Cache] Successfully cached formal file: ${path.basename(cacheFilePath)} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
          scheduleLRUEnforcement();
        } else {
          console.warn(`[Media Cache] Incomplete download for ${path.basename(cacheFilePath)} (got ${stat.size}/${expectedSize} bytes). Cleaning temp file.`);
          await fs.promises.unlink(tempPath);
        }
      }
    } catch (e: unknown) {
      console.warn(`[Media Cache] Download error for ${path.basename(cacheFilePath)}:`, (e as Error)?.message || e);
    } finally {
      await discardUpstream();
      activeTempPaths.delete(tempPath);
      activeDownloads.delete(cacheFilePath);
      releaseDownloadSlot();
      if (fs.existsSync(tempPath)) {
        try {
          await fs.promises.unlink(tempPath);
        } catch {}
      }
    }
  })();

  activeDownloads.set(cacheFilePath, downloadPromise);
  return downloadPromise;
}

/** Exposed for tests: number of downloads currently transferring. */
export function getActiveDownloadCount(): number {
  return slotsInUse;
}

/** Exposed for tests: number of downloads queued waiting for a slot. */
export function getQueuedDownloadCount(): number {
  return downloadQueue.length;
}

/** Exposed for tests: configured concurrency ceiling. */
export function getMaxConcurrentDownloads(): number {
  return MAX_CONCURRENT_DOWNLOADS;
}
