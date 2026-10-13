import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Readable } from 'stream';

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

export function getCacheStats(): { currentBytes: number; maxBytes: number; fileCount: number; maxGb: number } {
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
  return {
    currentBytes,
    maxBytes: MAX_CACHE_SIZE_BYTES,
    maxGb: Math.round(MAX_CACHE_SIZE_BYTES / (1024 * 1024 * 1024)),
    fileCount
  };
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

/** Upper bound for a cacheable asset (0 disables the check). Defaults to 4 GB. */
const MAX_CACHEABLE_BYTES = parseInt(process.env.MEDIA_CACHE_MAX_FILE_BYTES || '', 10) || 4 * 1024 * 1024 * 1024;

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
export async function cacheRemoteMedia(targetUrl: string, cacheFilePath: string, _reqHeaders?: HeadersInit): Promise<void> {
  const tempPath = `${cacheFilePath}.tmp`;

  if (isCached(cacheFilePath)) {
    return;
  }

  // Return existing in-flight background download if already running
  const inFlight = activeDownloads.get(cacheFilePath);
  if (inFlight) {
    return inFlight;
  }

  // If tempPath exists, check if it's active (< 5 minutes old)
  if (fs.existsSync(tempPath)) {
    try {
      const stat = fs.statSync(tempPath);
      if (Date.now() - stat.mtimeMs < 5 * 60 * 1000) {
        return; // Download actively progressing
      } else {
        fs.unlinkSync(tempPath); // Remove stale temp file
      }
    } catch {}
  }

  const downloadPromise = (async () => {
    // Reserve a slot BEFORE registering, so activeDownloads only ever contains
    // downloads that are actually transferring. Callers queue instead of
    // stampeding the origin when the budget is exhausted.
    await acquireDownloadSlot();
    activeTempPaths.add(tempPath);
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
        return;
      }

      // Reject HTML/SPA error pages served with a 200 status before writing anything.
      if (looksLikeHtmlContentType(res.headers.get('content-type'))) {
        console.warn(`[Media Cache] Refusing to cache HTML document for ${targetUrl} (content-type: ${res.headers.get('content-type')})`);
        return;
      }

      const contentLengthStr = res.headers.get('content-length');
      const expectedSize = contentLengthStr ? parseInt(contentLengthStr, 10) : 0;

      if (MAX_CACHEABLE_BYTES > 0 && expectedSize > MAX_CACHEABLE_BYTES) {
        console.warn(`[Media Cache] Skipping oversized asset (${expectedSize} bytes) for ${targetUrl}`);
        return;
      }

      const fileStream = fs.createWriteStream(tempPath);
      const nodeStream = Readable.fromWeb(res.body as any);

      nodeStream.pipe(fileStream);

      await new Promise<void>((resolve, reject) => {
        fileStream.on('finish', () => resolve());
        fileStream.on('error', (err) => reject(err));
        nodeStream.on('error', (err) => reject(err));
      });

      if (isCached(cacheFilePath)) {
        return;
      }

      if (fs.existsSync(tempPath)) {
        const stat = await fs.promises.stat(tempPath);
        if (stat.size > 0 && (expectedSize === 0 || stat.size >= expectedSize)) {
          // Second line of defence: the origin may omit or lie about content-type.
          if (await fileLooksLikeHtml(tempPath)) {
            console.warn(`[Media Cache] Discarding HTML-shaped payload for ${path.basename(cacheFilePath)}`);
            return;
          }
          await fs.promises.rename(tempPath, cacheFilePath);
          updateAccessTime(cacheFilePath);
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
