/**
 * Test bootstrap that redirects the media cache into a throwaway directory.
 *
 * Import this module BEFORE any module that resolves the cache path. ESM
 * evaluates imported modules in source order, so a side-effect import placed
 * first runs before the route handler is loaded.
 *
 * `getCacheDir()` re-reads MEDIA_CACHE_DIR on every call, so setting it here is
 * sufficient to keep a suite from writing into the repository's real cache.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'fy-test-cache-'));
const cacheDir = path.join(sandbox, 'data', 'media_cache');
fs.mkdirSync(cacheDir, { recursive: true });

// The helper rejects paths that do not contain "data" (a guard against a typo
// pointing the cache at an unrelated folder), so keep "data" in the path.
process.env.MEDIA_CACHE_DIR = cacheDir;

process.on('exit', () => {
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {}
});

export const SANDBOX_CACHE_DIR = cacheDir;
