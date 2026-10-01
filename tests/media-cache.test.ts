import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import {
  getCacheDir,
  ensureCacheDir,
  getCacheKey,
  getCacheFilePath,
  isCached,
  updateAccessTime,
  getCacheStats,
  cleanStaleTempFiles
} from '@/lib/serverMediaCache';

test('Media Cache 20GB & Storage Suite', async (t) => {
  await t.test('cache directory configuration and existence', () => {
    const dir = getCacheDir();
    assert.ok(dir.includes('media_cache'), 'Cache directory path must contain media_cache');
    const ensured = ensureCacheDir();
    assert.ok(fs.existsSync(ensured), 'ensureCacheDir must create or verify cache directory');
  });

  await t.test('20GB capacity and stats verification', () => {
    const stats = getCacheStats();
    assert.strictEqual(stats.maxGb, 20, 'Max cache capacity must be exactly 20 GB');
    assert.strictEqual(stats.maxBytes, 20 * 1024 * 1024 * 1024, 'Max bytes must be 21474836480 bytes (20 GB)');
    assert.ok(typeof stats.currentBytes === 'number' && stats.currentBytes >= 0, 'Current bytes must be a non-negative number');
    assert.ok(typeof stats.fileCount === 'number' && stats.fileCount >= 0, 'File count must be a non-negative number');
  });

  await t.test('cache key hashing is deterministic and collision-resistant', () => {
    const url1 = 'https://www.fayun.org/ftpadmin/audio/test1.mp3';
    const url2 = 'https://www.fayun.org/ftpadmin/audio/test2.mp3';

    const key1a = getCacheKey(url1);
    const key1b = getCacheKey(url1);
    const key2 = getCacheKey(url2);

    assert.strictEqual(key1a, key1b, 'Same URL must produce identical cache keys');
    assert.notStrictEqual(key1a, key2, 'Different URLs must produce different cache keys');
    assert.strictEqual(key1a.length, 32, 'MD5 cache key must be 32 hexadecimal characters');
  });

  await t.test('cache file path generation and extension sanitization', () => {
    const targetUrl = 'https://www.fayun.org/ftpadmin/audio/lecture01.mp3?download=1';
    const filePath = getCacheFilePath(targetUrl, 'mp3');

    assert.ok(filePath.endsWith('.mp3'), 'File path must preserve valid .mp3 extension');
    assert.ok(!filePath.includes('?'), 'File path must strip query parameters');

    const videoPath = getCacheFilePath('https://www.fayun.org/ftpadmin/video/01.mp4', '.mp4');
    assert.ok(videoPath.endsWith('.mp4'), 'File path must handle leading dot properly');

    const weirdExtPath = getCacheFilePath('https://www.fayun.org/test', '<script>');
    assert.ok(weirdExtPath.endsWith('.media'), 'Unsafe extensions must fall back to .media');
  });

  await t.test('isCached, updateAccessTime, and stale temp file cleanup', async () => {
    const testDir = ensureCacheDir();
    const testFile = path.join(testDir, 'unit_test_dummy_file.mp3');
    const testTemp = path.join(testDir, 'unit_test_dummy_file.mp3.tmp');

    // Write dummy file
    fs.writeFileSync(testFile, 'dummy audio data buffer');
    assert.ok(isCached(testFile), 'isCached must return true for existing non-empty file');

    // Update access time
    updateAccessTime(testFile);
    const stat = fs.statSync(testFile);
    assert.ok(Date.now() - stat.atimeMs < 5000, 'Access time must be updated to recent time');

    // Write dummy .tmp file with older mtime
    fs.writeFileSync(testTemp, 'interrupted download data');
    const oldTime = new Date(Date.now() - 4 * 60 * 1000); // 4 minutes ago
    fs.utimesSync(testTemp, oldTime, oldTime);

    // Clean stale temp files
    await cleanStaleTempFiles();
    assert.ok(!fs.existsSync(testTemp), 'Stale temp file older than 3 minutes must be cleaned up');

    // Clean up test file
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
    }
    assert.ok(!isCached(testFile), 'isCached must return false after file is deleted');
  });
});
