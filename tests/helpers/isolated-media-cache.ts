/**
 * Test bootstrap that redirects the media cache and task log directory into a
 * throwaway directory.
 *
 * Import this module BEFORE any module that resolves the cache path. ESM
 * evaluates imported modules in source order, so a side-effect import placed
 * first runs before the route handler is loaded.
 *
 * `getCacheDir()` re-reads MEDIA_CACHE_DIR on every call, so setting it here is
 * sufficient to keep a suite from writing into the repository's real cache.
 * TASK_LOG_DIR likewise keeps the maintenance lock out of `data/logs`, so a test
 * cannot plant a lock file that a concurrently running dev server would honour.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'fy-test-cache-'));
const cacheDir = path.join(sandbox, 'data', 'media_cache');
const logDir = path.join(sandbox, 'data', 'logs');
fs.mkdirSync(cacheDir, { recursive: true });
fs.mkdirSync(logDir, { recursive: true });

// The helper rejects paths that do not contain "data" (a guard against a typo
// pointing the cache at an unrelated folder), so keep "data" in the path.
process.env.MEDIA_CACHE_DIR = cacheDir;
process.env.TASK_LOG_DIR = logDir;

process.on('exit', () => {
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {}
});

export const SANDBOX_CACHE_DIR = cacheDir;
export const SANDBOX_LOG_DIR = logDir;
