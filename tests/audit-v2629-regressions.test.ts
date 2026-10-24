// Must come first: points MEDIA_CACHE_DIR at a throwaway directory.
import './helpers/isolated-media-cache';

import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

/**
 * Regression tests for the whole-site audit of v2.6.28.
 *
 * Each case pins a defect that was empirically reproduced, so a future edit
 * cannot silently reintroduce it. Where the behaviour is internal, the test
 * asserts the source contract in the same style as the existing suite (there is
 * no DOM tooling in this repo, and the cross-process paths cannot be exercised
 * deterministically in a single test process).
 */
const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf-8');

test('audit v2.6.29 — task triggers fail closed', async (t) => {
  await t.test('authorization no longer trusts client-supplied Origin/Host', () => {
    const src = read('src/lib/serverTasks.ts');
    // The trusted-authority set was built FROM the request's own Host /
    // X-Forwarded-Host, then compared against Origin, so a caller validated
    // itself. Both helpers must be gone.
    assert.doesNotMatch(src, /function allowedAuthorities/);
    assert.doesNotMatch(src, /function normalizeAuthority/);
  });

  await t.test('admin endpoints do not accept a same-origin request as a credential', () => {
    const src = read('src/lib/adminAuth.ts');
    // Origin/Host/Sec-Fetch are request-supplied; only a server-side session or
    // the explicit automation token may authorize admin actions.
    assert.match(src, /export function authorizeAdminRequest/);
    assert.match(src, /presentedTaskToken\(request\)/);
    assert.match(src, /getAdminSession\(/);
    assert.doesNotMatch(src, /if \(isSameOrigin\(request\)\) return \{ ok: true \}/);
  });

  await t.test('no boot-generated token remains', () => {
    const src = read('src/lib/serverTasks.ts');
    assert.doesNotMatch(src, /generatedTaskToken/);
    assert.match(src, /export function getTaskToken\(\): string \{\n  return \(process\.env\.TASK_API_TOKEN \|\| ''\)\.trim\(\);\n\}/);
    assert.match(src, /export function isValidTaskToken/);
  });

  await t.test('the boot log reports credential state without printing a secret', () => {
    const src = read('src/instrumentation.ts');
    assert.match(src, /readAdminCredential/);
    assert.match(src, /TASK_API_TOKEN/);
    assert.doesNotMatch(src, /getTaskToken\(\)/);
  });

  await t.test('public status keeps logs and lock-holder behind auth', () => {
    for (const route of ['src/app/api/scan/route.ts', 'src/app/api/health-check/route.ts']) {
      const src = read(route);
      assert.match(src, /getOptionalAdminAuth\(request\)/);
      assert.match(src, /logsRestricted: !admin/);
      assert.match(src, /recentLogs: admin \? readRecentLogs\(\) : undefined/);
      assert.match(src, /lockHolder: admin \? getScanLockInfoPublic\(\) : undefined/);
    }
  });

  await t.test('the ownership token is never returned over HTTP', () => {
    for (const route of ['src/app/api/scan/route.ts', 'src/app/api/health-check/route.ts']) {
      const src = read(route);
      assert.doesNotMatch(src, /lockHolder: getScanLockInfo\(\)/);
      assert.match(src, /getScanLockInfoPublic\(\)/);
    }
    const lib = read('src/lib/serverTasks.ts');
    assert.match(lib, /export function stripLockToken/);
  });
});

test('audit v2.6.29 — media cache cannot serve a spliced file', async (t) => {
  await t.test('the scratch path is unique per attempt', () => {
    const src = read('src/lib/serverMediaCache.ts');
    // A deterministic `${cacheFilePath}.tmp` is the SAME name in every process,
    // so two writers interleaved into one file and a splice was committed and
    // served as a cache HIT. The Python side already used a unique name.
    assert.match(src, /const tempPath = `\$\{cacheFilePath\}\.\$\{process\.pid\}\.\$\{crypto\.randomUUID\(\)\}\.tmp`;/);
    assert.doesNotMatch(src, /const tempPath = `\$\{cacheFilePath\}\.tmp`;/);
  });

  await t.test('bookkeeping is released before awaiting upstream cancel', () => {
    const src = read('src/lib/serverMediaCache.ts');
    // Scope to the download function's OWN finally block: `activeDownloads
    // .delete` and `releaseDownloadSlot` also appear earlier in the file (slot
    // reservation failure, and the release helper itself), so a naive search
    // finds the wrong occurrences.
    const fnStart = src.indexOf('export async function cacheRemoteMedia');
    const fnBody = src.slice(fnStart, src.indexOf('\n  activeDownloads.set(cacheFilePath, downloadPromise);', fnStart));
    const finallyIdx = fnBody.lastIndexOf('} finally {');
    assert.ok(finallyIdx > -1, 'the download must have a finally block');
    const finallyBlock = fnBody.slice(finallyIdx);
    // `await upstream.cancel()` can never settle on a wedged socket. When it was
    // awaited first, the slot was never returned and the download subsystem
    // stayed silently wedged.
    const deleteIdx = finallyBlock.indexOf('activeDownloads.delete(cacheFilePath)');
    const releaseIdx = finallyBlock.indexOf('releaseDownloadSlot()');
    const cancelIdx = finallyBlock.indexOf('await discardUpstream()');
    assert.ok(deleteIdx > -1 && releaseIdx > -1 && cancelIdx > -1);
    assert.ok(deleteIdx < cancelIdx, 'activeDownloads must be cleared before the await');
    assert.ok(releaseIdx < cancelIdx, 'releaseDownloadSlot must run before the await');
  });

  await t.test('in-use pins are refcounted, not a set', () => {
    const src = read('src/lib/serverMediaCache.ts');
    // A Set let the first of two concurrent readers clear the pin for both, so
    // LRU could evict a file still being streamed and the next Range request
    // failed with ENOENT.
    assert.match(src, /const filesInUse = new Map<string, number>\(\);/);
    assert.match(src, /export function getInUseRefCount/);
  });

  await t.test('MEDIA_CACHE_MAX_FILE_BYTES=0 means unlimited', () => {
    const src = read('src/lib/serverMediaCache.ts');
    // `parseInt(...) || default` collapsed an explicit 0 to 4 GiB, the opposite
    // of the documented "0 disables the check".
    assert.match(src, /parsed === 0 \? Number\.POSITIVE_INFINITY : parsed/);
    assert.doesNotMatch(src, /parseInt\(process\.env\.MEDIA_CACHE_MAX_FILE_BYTES \|\| '', 10\) \|\|/);
  });
});

test('audit v2.6.29 — the scan lock is not handed to a live holder', async (t) => {
  await t.test('holder liveness is decided before age', () => {
    const src = read('src/lib/serverTasks.ts');
    const fn = src.slice(src.indexOf('function lockIsLive'), src.indexOf('function tryUnlinkLock'));
    const aliveIdx = fn.indexOf('isProcessAlive(info.pid)');
    // The age rule used to run FIRST, so a lock whose heartbeat stalled was
    // reclaimed even though its holder was demonstrably alive.
    assert.ok(aliveIdx > -1, 'liveness must be consulted');
    assert.match(fn, /if \(sameHost\) \{/);
  });

  await t.test('stale reclamation is atomic, not a stat-then-unlink', () => {
    const src = read('src/lib/serverTasks.ts');
    // An unlink based on an earlier stat is a TOCTOU: a peer can replace the
    // stale lock in between and we delete its fresh one. Verified: 88/215
    // acquisitions were stolen from their owner.
    assert.match(src, /function tryReclaimStaleLock/);
    assert.match(src, /fs\.renameSync\(lockPath, claimPath\)/);
    const acquire = src.slice(src.indexOf('export function acquireScanLock'));
    assert.doesNotMatch(acquire.slice(0, acquire.indexOf('export function')), /tryUnlinkLock\(\)/);
  });

  await t.test('a live Python catalog writer blocks the /api/courses upgrade', () => {
    const lib = read('src/lib/serverTasks.ts');
    assert.match(lib, /export function isCatalogRunActive/);
    // The reconcile moved out of the GET route into lib/catalogReconcile.
    const route = read('src/lib/catalogReconcile.ts');
    assert.match(route, /isRunActive \?\? isCatalogRunActive/);
    // The upgrade swaps the inode a running scan is about to mirror, so the
    // scan's own output was silently discarded and the catalog regressed.
    assert.match(route, /Skipped auto-upgrade: a maintenance run is currently writing the catalog/);
  });

  await t.test('catalog replacement is atomic and invalidates on inode change', () => {
    const route = read('src/app/api/courses/route.ts');
    // `copyFileSync` straight onto the catalog is not atomic.
    const reconcile = read('src/lib/catalogReconcile.ts');
    assert.doesNotMatch(reconcile, /fs\.copyFileSync\(srcFile, dataFile\)/);
    assert.match(reconcile, /atomicWrite\(dataFile/);
    // The memo must notice a same-size same-mtime replacement.
    assert.match(route, /st\.ino\}:\$\{st\.ctimeMs\}/);
  });
});

test('audit v2.6.29 — log directory probe reports the truth', async (t) => {
  await t.test('a failing unlink is not reported as unwritable', () => {
    const src = read('src/lib/serverTasks.ts');
    const fn = src.slice(src.indexOf('export function checkLogDirWritable'), src.indexOf('export function reclaimOrphanedLock'));
    // The write and the unlink used to share one try, so a failed cleanup
    // reported `writable: false` even though the write had just succeeded --
    // sending the operator after the wrong problem.
    const writeIdx = fn.indexOf("fs.writeFileSync(probe, 'ok')");
    const unlinkIdx = fn.indexOf('fs.unlinkSync(probe)');
    assert.ok(writeIdx > -1 && unlinkIdx > -1);
    const between = fn.slice(writeIdx, unlinkIdx);
    assert.match(between, /\} catch \(e: unknown\) \{/, 'the write must have its own catch');
    assert.match(fn.slice(unlinkIdx), /writable: true/, 'unlink failure keeps writable true');
  });
});

test('audit v2.6.29 — proxy response framing and hardening', async (t) => {
  await t.test('the upstream content-length is not copied', () => {
    const src = read('src/app/api/proxy/route.ts');
    // undici decompresses the body while the header describes the COMPRESSED
    // length, so forwarding it desynchronised the response framing.
    assert.doesNotMatch(src, /resHeaders\.set\('Content-Length', response\.headers\.get\('content-length'\)!\)/);
  });

  await t.test('the 416 path reuses the hardened headers', () => {
    const src = read('src/app/api/proxy/route.ts');
    const idx = src.indexOf("status: 416");
    assert.ok(idx > -1);
    // A fresh literal dropped every security header applied just above.
    assert.doesNotMatch(src.slice(idx, idx + 300), /headers: \{\s*'Content-Range'/);
    assert.match(src.slice(idx - 400, idx), /resHeaders\.set\('Content-Range'/);
  });

  await t.test('an ordinary cache-miss GET is budgeted', () => {
    const src = read('src/app/api/proxy/route.ts');
    // Only `action=preload` was limited, so anonymous GETs drove unbounded disk
    // writes (25 plain GETs produced zero throttling).
    assert.match(src, /checkCacheMissDownloadLimit/);
    assert.match(src, /isDownloadInFlight/);
  });
});

test('audit v2.6.29 — runtime state never ships in the image', async (t) => {
  await t.test('.dockerignore excludes data/', () => {
    const src = read('.dockerignore');
    // `COPY . .` picked up the host's live catalog and log history, pushing
    // operator data to the registry as image layers.
    assert.match(src, /^data$/m);
    assert.match(src, /^data\/\*\*$/m);
  });
});
