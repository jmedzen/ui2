import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The GHCR prune script keeps the newest N *builds*, not the newest N package
 * versions.
 *
 * That distinction is the whole point of the script, and it is easy to
 * reintroduce the old behaviour by "simplifying" the grouping away, so the
 * behaviour is pinned here. Each test drives the real script through a stub
 * `gh` that records the versions it was asked to delete.
 */

const repoRoot = path.join(process.cwd());
const scriptPath = path.join(repoRoot, '.github', 'scripts', 'prune-ghcr.sh');

interface Harness {
  dir: string;
  run: (options?: { keep?: string; dryRun?: boolean }) => { stdout: string; deleted: string[] };
}

/**
 * Builds a sandbox containing a stub `gh` and the given version listing.
 *
 * @param rows [id, created_at, digest, tags] tuples in the shape the real API
 *             returns after the jq projection.
 */
function harness(rows: Array<[string, string, string, string]>): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-ghcr-'));
  const apiTsv = rows.map((r) => r.join('\t')).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'api.tsv'), apiTsv);

  // Stub `gh`: serve the fixture on list, log deletes to a file.
  const stub = `#!/usr/bin/env bash
case "$1 $2" in
  "api --paginate") cat "${dir}/api.tsv"; exit 0 ;;
  "api --method") echo "$4" >> "${dir}/deleted.log"; exit 0 ;;
esac
echo "stub-unexpected: $*" >&2
exit 9
`;
  fs.writeFileSync(path.join(dir, 'gh'), stub, { mode: 0o755 });

  return {
    dir,
    run({ keep = '5', dryRun = false } = {}) {
      const deletedLog = path.join(dir, 'deleted.log');
      if (fs.existsSync(deletedLog)) fs.unlinkSync(deletedLog);

      const stdout = execFileSync('bash', [scriptPath], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          GH_TOKEN: 'stub-token',
          PACKAGE_NAME: 'ui2',
          MIN_IMAGES_TO_KEEP: keep,
          GITHUB_REPOSITORY: 'jmedzen/ui2',
          DRY_RUN: dryRun ? '1' : '0'
        }
      });

      const deleted = fs.existsSync(deletedLog)
        ? fs.readFileSync(deletedLog, 'utf8').trim().split('\n').filter(Boolean)
        : [];
      return { stdout, deleted };
    }
  };
}

/** Six builds, three versions each; only the newest carries `latest`. */
function sixBuilds(): Array<[string, string, string, string]> {
  const rows: Array<[string, string, string, string]> = [];
  const digests = ['aaa', 'bbb', 'ccc', 'ddd', 'eee', 'fff'];
  digests.forEach((digest, i) => {
    const day = String(20 + i).padStart(2, '0');
    const latest = i === digests.length - 1 ? 'latest,' : '';
    rows.push([String(1000 + i * 10 + 1), `2026-10-${day}T01:00:00Z`, `sha256:${digest}`, `${latest}main,sha-${digest}`]);
    rows.push([String(1000 + i * 10 + 2), `2026-10-${day}T01:00:01Z`, `sha256:${digest}`, `sha-${digest}-b`]);
    rows.push([String(1000 + i * 10 + 3), `2026-10-${day}T01:00:02Z`, `sha256:${digest}`, `sha-${digest}-c`]);
  });
  return rows;
}

test('GHCR prune keeps whole builds, not individual versions', async (t) => {
  await t.test('keeps five builds and drops every tag of the sixth', () => {
    const h = harness(sixBuilds());
    const { stdout, deleted } = h.run({ keep: '5' });

    assert.match(stdout, /Found 18 version\(s\) across 6 image build\(s\)/);
    // The oldest build is three versions that must go together.
    assert.deepEqual(deleted.sort(), [
      'users/jmedzen/packages/container/ui2/versions/1001',
      'users/jmedzen/packages/container/ui2/versions/1002',
      'users/jmedzen/packages/container/ui2/versions/1003'
    ]);
  });

  await t.test('the kept builds are exactly the newest ones', () => {
    const h = harness(sixBuilds());
    h.run({ keep: '5' });
    const deleted = fs.readFileSync(path.join(h.dir, 'deleted.log'), 'utf8').trim().split('\n');

    // Nothing from builds bbb..fff (ids 1011 and above) may be deleted.
    for (const line of deleted) {
      const id = Number(line.split('/').pop());
      assert.ok(id < 1011, `deleted a version from a build that should be kept: ${id}`);
    }
  });

  await t.test('a version-based count would have cut a build in half', () => {
    // Pins the regression: keeping "5 versions" of 18 keeps only part of one
    // build. Keeping 1 build must still delete 15 versions, not 13.
    const h = harness(sixBuilds());
    const { deleted } = h.run({ keep: '1' });
    assert.strictEqual(deleted.length, 15, 'keeping 1 build deletes the other 5 builds x 3 versions');
  });

  await t.test('never deletes the version carrying the latest tag', () => {
    // Simulate drift: an old build still tagged latest, outside the newest N.
    const rows = sixBuilds();
    rows[0][3] = 'latest,main';           // oldest build carries latest
    rows[rows.length - 1][3] = 'main';    // newest no longer does

    const h = harness(rows);
    const { stdout, deleted } = h.run({ keep: '2' });

    // The oldest build is due for removal, but its latest-tagged version is not.
    assert.ok(
      !deleted.some((line) => line.endsWith('/1001')),
      'the latest-tagged version must survive'
    );
    assert.match(stdout, /Skipping version 1001/);
    // Its untagged siblings still go.
    assert.ok(deleted.some((line) => line.endsWith('/1002')));
  });
});

test('GHCR prune is safe at the boundaries', async (t) => {
  await t.test('does nothing when the build count equals the limit', () => {
    const rows = sixBuilds().slice(0, 15); // five builds
    const h = harness(rows);
    const { stdout, deleted } = h.run({ keep: '5' });
    assert.match(stdout, /Nothing to prune/);
    assert.deepEqual(deleted, []);
  });

  await t.test('does nothing when there are fewer builds than the limit', () => {
    const h = harness(sixBuilds().slice(0, 6)); // two builds
    const { stdout, deleted } = h.run({ keep: '5' });
    assert.match(stdout, /Nothing to prune/);
    assert.deepEqual(deleted, []);
  });

  await t.test('dry run reports without deleting', () => {
    const h = harness(sixBuilds());
    const { stdout, deleted } = h.run({ keep: '5', dryRun: true });
    assert.match(stdout, /\[dry-run\] Would delete version 1001/);
    assert.deepEqual(deleted, [], 'dry run must not issue any DELETE');
  });

  await t.test('rejects a keep count that would delete everything', () => {
    const h = harness(sixBuilds());
    // The script exits 1 and reports why. `execFileSync` captures stdout even on
    // failure, so both channels are checked rather than assuming one.
    assert.throws(
      () => h.run({ keep: '0' }),
      (error: unknown) => {
        const e = error as { status?: number; stdout?: string; stderr?: string };
        assert.strictEqual(e.status, 1);
        assert.match(
          `${e.stdout ?? ''}${e.stderr ?? ''}`,
          /MIN_IMAGES_TO_KEEP must be an integer >= 1/
        );
        return true;
      }
    );
  });

  await t.test('tolerates a version with no digest or tags', () => {
    const rows = sixBuilds();
    // An untagged version: no digest, no tags at all.
    rows[0] = ['1001', '2026-10-20T01:00:00Z', '', ''];
    const h = harness(rows);
    const { stdout, deleted } = h.run({ keep: '5' });
    // Without a digest the version cannot be attributed to a build, so it is
    // bucketed on its own. That makes six builds into seven, and the extra
    // bucket is the oldest, so it is deleted with the first build's tags.
    assert.match(stdout, /across 7 image build\(s\)/);
    assert.match(stdout, /Deleting version 1001 .*tags: none/);
    assert.ok(deleted.length > 0);
  });
});
