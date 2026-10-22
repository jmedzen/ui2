import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const SW_PATH = path.join(process.cwd(), 'public', 'sw.js');
const src = fs.readFileSync(SW_PATH, 'utf-8');

test('Service worker', async (t) => {
  await t.test('exists and is valid JavaScript', () => {
    assert.ok(src.length > 500, 'sw.js should not be a stub');
    // Parse without executing: a syntax error here would silently disable all
    // offline support, and the browser reports it only in devtools.
    assert.doesNotThrow(() => new Function(src));
  });

  await t.test('never caches a partial (206) media response', () => {
    // Storing a 206 body and replaying it produces silent gaps mid-lecture.
    assert.match(src, /response\.status === 200/);
    assert.match(src, /Range/i);
    assert.match(src, /request\.headers\.get\('range'\)/);
  });

  await t.test('skips range requests instead of serving them from cache', () => {
    assert.match(src, /if \(request\.headers\.get\('range'\)\) return;/);
    assert.match(src, /request\.method !== 'GET'/);
  });

  await t.test('leaves the admin and scan APIs uncached', () => {
    // A stale admin session or scan result is a security and correctness bug,
    // not a performance win.
    assert.match(src, /\/api\/admin\//);
    assert.match(src, /\/api\/scan/);
  });

  await t.test('only handles same-origin traffic', () => {
    assert.match(src, /url\.origin !== self\.location\.origin/);
  });

  await t.test('bounds the media cache', () => {
    assert.match(src, /MEDIA_CACHE_MAX_ENTRIES/);
    assert.match(src, /trimMediaCache/);
  });

  await t.test('does not pre-cache hashed build assets', () => {
    // Pre-caching would pin users to a stale bundle after every deploy, so the
    // install handler must not add to any cache.
    assert.match(src, /self\.addEventListener\('install'/, 'install handler should exist');
    const installBlock = src.slice(
      src.indexOf("self.addEventListener('install'"),
      src.indexOf("self.addEventListener('activate'")
    );
    assert.doesNotMatch(installBlock, /caches\.open/, 'install must not open a cache');
    assert.doesNotMatch(src, /_next\/static/);
  });

  await t.test('registration is skipped in development', () => {
    // A worker in `next dev` serves stale chunks after every edit.
    const hook = fs.readFileSync(
      path.join(process.cwd(), 'src', 'lib', 'useServiceWorker.ts'),
      'utf-8'
    );
    assert.match(hook, /process\.env\.NODE_ENV !== 'production'/);
    assert.match(hook, /navigator\.serviceWorker\.register\('\/sw\.js'/);
    // A blocked registration (private mode) must not break the page.
    assert.match(hook, /catch \(error\)/);
  });
});
