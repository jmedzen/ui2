import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Readable } from 'stream';

const CACHE_DIR = process.env.MEDIA_CACHE_DIR || path.join(process.cwd(), 'media_cache');
const MAX_CACHE_SIZE_BYTES = parseInt(process.env.MEDIA_CACHE_MAX_BYTES || '', 10) || 2 * 1024 * 1024 * 1024; // 2 GB
const TARGET_CACHE_SIZE_BYTES = parseInt(process.env.MEDIA_CACHE_TARGET_BYTES || '', 10) || Math.floor(MAX_CACHE_SIZE_BYTES * 0.8); // 1.6 GB High-water mark after eviction

// Ensure cache directory exists
try {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
} catch (e) {
  console.warn('Failed to create media cache directory:', e);
}

export function getCacheKey(targetUrlOrPath: string): string {
  return crypto.createHash('md5').update(targetUrlOrPath).digest('hex');
}

export function getCacheFilePath(targetUrlOrPath: string, ext: string): string {
  const hash = getCacheKey(targetUrlOrPath);
  const rawExt = (ext || '').split('?')[0].replace(/^\./, '');
  const cleanExt = rawExt && /^[a-zA-Z0-9]+$/.test(rawExt) ? `.${rawExt}` : '.media';
  return path.join(CACHE_DIR, `${hash}${cleanExt}`);
}

export function isCached(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

export function updateAccessTime(filePath: string): void {
  try {
    const now = new Date();
    fs.utimesSync(filePath, now, now);
  } catch (e) {
    console.warn('Failed to update file access time:', e);
  }
}

/**
 * Enforces 15GB LRU Eviction Limit on Server Cache Directory
 */
export async function enforceLRULimit(): Promise<void> {
  try {
    if (!fs.existsSync(CACHE_DIR)) return;

    const files = await fs.promises.readdir(CACHE_DIR);
    let totalSize = 0;

    const fileStats: { filePath: string; size: number; atimeMs: number }[] = [];

    for (const filename of files) {
      const fullPath = path.join(CACHE_DIR, filename);
      try {
        const stat = await fs.promises.stat(fullPath);
        if (stat.isFile()) {
          totalSize += stat.size;
          fileStats.push({
            filePath: fullPath,
            size: stat.size,
            atimeMs: stat.atimeMs
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

    // Sort by atime ascending (oldest access time first)
    fileStats.sort((a, b) => a.atimeMs - b.atimeMs);

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
 * Downloads remote media file to server cache disk in background
 */
export async function cacheRemoteMedia(targetUrl: string, cacheFilePath: string, reqHeaders: HeadersInit): Promise<void> {
  // Prevent duplicate concurrent background downloads for the same file
  const tempPath = `${cacheFilePath}.tmp`;

  if (isCached(cacheFilePath) || fs.existsSync(tempPath)) {
    return;
  }

  try {
    const res = await fetch(targetUrl, {
      headers: reqHeaders,
      cache: 'no-store'
    });

    if (!res.ok || !res.body) {
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

    // Double-checked locking: If Stream Teeing already cached the file while downloading, clean up temp file
    if (isCached(cacheFilePath)) {
      try {
        if (fs.existsSync(tempPath)) await fs.promises.unlink(tempPath);
      } catch {}
      return;
    }

    if (fs.existsSync(tempPath)) {
      await fs.promises.rename(tempPath, cacheFilePath);
      updateAccessTime(cacheFilePath);
      console.log(`[Media Cache] Successfully cached file: ${path.basename(cacheFilePath)}`);
      enforceLRULimit();
    }
  } catch (e: any) {
    // Only warn if unexpected error (ignore expected cancellation/race condition cleanup)
    if (fs.existsSync(tempPath)) {
      try {
        await fs.promises.unlink(tempPath);
      } catch {}
    }
  }
}
