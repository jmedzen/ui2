import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { POST as listFiles } from '@/app/api/list-files/route';

const HOST = 'http://localhost:8410';
let n = 0;
/** Each test uses fresh `src` values so the route's in-memory cache never leaks between tests. */
const uniq = (label: string) => `/media/${label}-${process.pid}-${n++}`;

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push(url);
    return handler(url, init);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const post = (body: string, headers: Record<string, string> = {}) =>
  listFiles(new Request(`${HOST}/api/list-files`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }));

test('list-files — bounded request input', async (t) => {
  await t.test('an oversized body is refused before parsing', async () => {
    const res = await post(JSON.stringify({ src: '/a', pad: 'x'.repeat(10_000) }));
    assert.strictEqual(res.status, 413);
  });
  await t.test('an overlong src is refused', async () => {
    const res = await post(JSON.stringify({ src: '/' + 'a'.repeat(1100) }));
    assert.strictEqual(res.status, 400);
  });
  await t.test('malformed JSON is still a 400', async () => {
    assert.strictEqual((await post('{nope')).status, 400);
  });
});

test('list-files — negative cache only for client errors', async () => {
  const { calls, restore } = stubFetch(() => new Response('busy', { status: 503 }));
  try {
    const src = uniq('5xx');
    assert.strictEqual((await post(JSON.stringify({ src }))).status, 503);
    assert.strictEqual((await post(JSON.stringify({ src }))).status, 503);
    assert.strictEqual(calls.length, 2, 'a transient 5xx must not be cached for 10 minutes');
  } finally {
    restore();
  }
  const notFound = stubFetch(() => new Response('', { status: 404 }));
  try {
    const src = uniq('404');
    await post(JSON.stringify({ src }));
    await post(JSON.stringify({ src }));
    assert.strictEqual(notFound.calls.length, 1, 'a missing directory is still negative-cached');
  } finally {
    notFound.restore();
  }
});

test('list-files — upstream lookups are budgeted, cache hits are free', async () => {
  const saved = process.env.LIST_FILES_MAX_PER_MINUTE;
  const savedTrust = process.env.TRUST_PROXY;
  process.env.LIST_FILES_MAX_PER_MINUTE = '3';
  // A client of its own: the budget is per client, and earlier tests in this
  // file already spent some of the shared 'local' bucket.
  process.env.TRUST_PROXY = '1';
  const me = { 'x-forwarded-for': '203.0.113.77' };
  const { calls, restore } = stubFetch(() => new Response(JSON.stringify({ status: true, data: ['a.mp3'] })));
  try {
    const hot = uniq('hot');
    assert.strictEqual((await post(JSON.stringify({ src: hot }), me)).status, 200);
    for (let i = 0; i < 5; i++) {
      assert.strictEqual((await post(JSON.stringify({ src: hot }), me)).status, 200, 'hits are not charged');
    }
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await post(JSON.stringify({ src: uniq('cold') }), me)).status);
    assert.deepStrictEqual(statuses, [200, 200, 429, 429], 'distinct misses beyond the budget are throttled');
    assert.strictEqual(calls.length, 3);
    // Another client is unaffected.
    assert.strictEqual((await post(JSON.stringify({ src: uniq('other') }), { 'x-forwarded-for': '198.51.100.9' })).status, 200);
  } finally {
    restore();
    if (saved === undefined) delete process.env.LIST_FILES_MAX_PER_MINUTE;
    else process.env.LIST_FILES_MAX_PER_MINUTE = saved;
    if (savedTrust === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = savedTrust;
  }
});

test('list-files — goes through the upstream policy', async () => {
  // Fresh module-level budget is shared across this file, so use the default.
  const evil = stubFetch((url) =>
    url.includes('evil.example') ? new Response('{}') : new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })
  );
  try {
    const res = await post(JSON.stringify({ src: uniq('redir') }));
    assert.strictEqual(res.status, 502);
    assert.ok(!evil.calls.some((u) => u.includes('evil.example')));
  } finally {
    evil.restore();
  }
});

test('CI — third-party actions are pinned to commit SHAs', () => {
  for (const file of ['docker-publish.yml', 'prune-images.yml']) {
    const src = fs.readFileSync(path.join(process.cwd(), '.github', 'workflows', file), 'utf-8');
    for (const line of src.split('\n').filter((l) => /^\s*uses:/.test(l))) {
      assert.match(line, /@[0-9a-f]{40}\b/, `${file}: ${line.trim()} must be pinned to a full SHA`);
    }
  }
  assert.ok(fs.existsSync(path.join(process.cwd(), '.github', 'dependabot.yml')), 'pins must be kept current');
});

test('GHCR prune targets /orgs for an organization-owned package', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-org-'));
  try {
    const row = (i: number, hour: number) => `${i}\t2026-10-2${hour}T00:00:00Z\tsha256:d${i}\tsha-${i}`;
    fs.writeFileSync(path.join(dir, 'api.tsv'), [1, 2, 3].map((i) => row(i, i)).join('\n') + '\n');
    fs.writeFileSync(
      path.join(dir, 'gh'),
      `#!/usr/bin/env bash
case "$1 $2" in
  "api users/acme") echo Organization; exit 0 ;;
  "api --paginate") echo "$3" >> "${dir}/listed.log"; cat "${dir}/api.tsv"; exit 0 ;;
  "api --method") echo "$4" >> "${dir}/deleted.log"; exit 0 ;;
esac
exit 9
`,
      { mode: 0o755 }
    );
    execFileSync('bash', [path.join(process.cwd(), '.github', 'scripts', 'prune-ghcr.sh')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_TOKEN: 't', PACKAGE_NAME: 'ui2', MIN_IMAGES_TO_KEEP: '1', GITHUB_REPOSITORY: 'acme/ui2', DRY_RUN: '0', DEBUG: '0' }
    });
    assert.match(fs.readFileSync(path.join(dir, 'listed.log'), 'utf8'), /^orgs\/acme\/packages\/container\/ui2\/versions/);
    const deleted = fs.readFileSync(path.join(dir, 'deleted.log'), 'utf8').trim().split('\n');
    assert.ok(deleted.length === 2 && deleted.every((d) => d.startsWith('orgs/acme/')), deleted.join(','));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
