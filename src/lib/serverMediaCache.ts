import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Readable } from 'stream';

const CACHE_DIR = (() => {
  const envDir = process.env.MEDIA_CACHE_DIR;
  if (envDir && envDir.includes('data')) {
    return envDir;
  }
  return path.join(process.cwd(), 'data', 'media_cache');
})();

const MAX_CACHE_SIZE_BYTES = parseInt(process.env.MEDIA_CACHE_MAX_BYTES || '', 10) || 2 * 1024 * 1024 * 1024; // 2 GB
const TARGET_CACHE_SIZE_BYTES = parseInt(process.env.MEDIA_CACHE_TARGET_BYTES || '', 10) || Math.floor(MAX_CACHE_SIZE_BYTES * 0.8); // 1.6 GB High-water mark after eviction

// Ensure target data/media_cache directory exists and migrate all legacy media cache folders (audio/video/PDF)
try {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  const legacyDirs = [
    path.join(process.cwd(), 'media_cache'),
    path.join(process.cwd(), 'cache')
  ];

  for (const legacyDir of legacyDirs) {
    if (fs.existsSync(legacyDir) && legacyDir !== CACHE_DIR) {
      const legacyFiles = fs.readdirSync(legacyDir);
      for (const file of legacyFiles) {
        const srcFile = path.join(legacyDir, file);
        const destFile = path.join(CACHE_DIR, file);
        try {
          if (!fs.existsSync(destFile)) {
            try {
              fs.renameSync(srcFile, destFile);
            } catch {
              fs.copyFileSync(srcFile, destFile);
              try { fs.unlinkSync(srcFile); } catch {}
            }
          } else {
            try { fs.unlinkSync(srcFile); } catch {}
          }
        } catch (err) {
          console.warn(`[Media Cache Migration] Could not move ${file}:`, err);
        }
      }
      try {
        if (fs.readdirSync(legacyDir).length === 0) {
          fs.rmdirSync(legacyDir);
        }
      } catch {}
    }
  }
} catch (e) {
  console.warn('Failed to create or migrate media cache directory:', e);
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
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
      return true;
    }
    // Runtime safety net: check legacy media_cache folder for on-demand migration
    const fileName = path.basename(filePath);
    const legacyFilePath = path.join(process.cwd(), 'media_cache', fileName);
    if (fs.existsSync(legacyFilePath) && fs.statSync(legacyFilePath).size > 0) {
      try {
        if (!fs.existsSync(path.dirname(filePath))) {
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
        }
        fs.renameSync(legacyFilePath, filePath);
        return true;
      } catch {
        try {
          fs.copyFileSync(legacyFilePath, filePath);
          fs.unlinkSync(legacyFilePath);
          return true;
        } catch {}
      }
    }
    return false;
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
 * Removes any stale temporary (.tmp) files left behind by interrupted downloads
 */
export async function cleanStaleTempFiles(): Promise<void> {
  try {
    if (!fs.existsSync(CACHE_DIR)) return;
    const files = await fs.promises.readdir(CACHE_DIR);
    const now = Date.now();
    for (const filename of files) {
      if (filename.endsWith('.tmp')) {
        const fullPath = path.join(CACHE_DIR, filename);
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

// Automatically clean stale .tmp files when module initializes
cleanStaleTempFiles();

/**
 * Enforces LRU Eviction Limit on Server Cache Directory
 */
export async function enforceLRULimit(): Promise<void> {
  try {
    if (!fs.existsSync(CACHE_DIR)) return;

    await cleanStaleTempFiles();

    const files = await fs.promises.readdir(CACHE_DIR);
    let totalSize = 0;

    const fileStats: { filePath: string; size: number; atimeMs: number }[] = [];

    for (const filename of files) {
      if (filename.endsWith('.tmp')) continue; // Exclude active temp files from LRU size
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

// Map to prevent duplicate concurrent background downloads for the same target file
const activeDownloads = new Map<string, Promise<void>>();

/**
 * Downloads remote media file to server cache disk in background and renames it to a formal file upon completion
 */
export async function cacheRemoteMedia(targetUrl: string, cacheFilePath: string, _reqHeaders?: HeadersInit): Promise<void> {
  const tempPath = `${cacheFilePath}.tmp`;

  if (isCached(cacheFilePath)) {
    return;
  }

  // Return existing in-flight background download if already running
  if (activeDownloads.has(cacheFilePath)) {
    return activeDownloads.get(cacheFilePath);
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

      const contentLengthStr = res.headers.get('content-length');
      const expectedSize = contentLengthStr ? parseInt(contentLengthStr, 10) : 0;

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
          await fs.promises.rename(tempPath, cacheFilePath);
          updateAccessTime(cacheFilePath);
          console.log(`[Media Cache] Successfully cached formal file: ${path.basename(cacheFilePath)} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
          enforceLRULimit();
        } else {
          console.warn(`[Media Cache] Incomplete download for ${path.basename(cacheFilePath)} (got ${stat.size}/${expectedSize} bytes). Cleaning temp file.`);
          await fs.promises.unlink(tempPath);
        }
      }
    } catch (e: any) {
      console.warn(`[Media Cache] Download error for ${path.basename(cacheFilePath)}:`, e?.message || e);
    } finally {
      activeDownloads.delete(cacheFilePath);
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
