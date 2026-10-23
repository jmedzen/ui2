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
 * The grouping rule is the subtle part, so it is pinned here against data
 * captured from the real registry. A single `docker buildx` push produces three
 * versions with three *different* digests:
 *
 *   1433233153 | 2026-10-23T07:49:44Z | sha256:ddaa8e13... | sha-70e9e70,latest,main
 *   1433233116 | 2026-10-23T07:49:44Z | sha256:75acf533... |
 *   1433233075 | 2026-10-23T07:49:43Z | sha256:525b2695... |
 *
 * Only one carries tags; the others are attestation manifests. Because no two
 * versions share a digest, grouping by digest silently degenerates into "every
 * version is its own build" - which is exactly the bug these tests guard
 * against. Builds are therefore clustered on creation time.
 */

const repoRoot = process.cwd();
const scriptPath = path.join(repoRoot, '.github', 'scripts', 'prune-ghcr.sh');

type Row = [id: string, createdAt: string, digest: string, tags: string];

interface Harness {
  dir: string;
  run: (options?: { keep?: string; dryRun?: boolean }) => { stdout: string; deleted: string[] };
}

function harness(rows: Row[]): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-ghcr-'));
  fs.writeFileSync(path.join(dir, 'api.tsv'), rows.map((r) => r.join('\t')).join('\n') + '\n');

  // Stub `gh`: serve the fixture on list, record deletes to a file.
  fs.writeFileSync(
    path.join(dir, 'gh'),
    `#!/usr/bin/env bash
case "$1 $2" in
  "api --paginate") cat "${dir}/api.tsv"; exit 0 ;;
  "api --method") echo "$4" >> "${dir}/deleted.log"; exit 0 ;;
esac
echo "stub-unexpected: $*" >&2
exit 9
`,
    { mode: 0o755 }
  );

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
          DRY_RUN: dryRun ? '1' : '0',
          DEBUG: '0'
        }
      });

      const deleted = fs.existsSync(deletedLog)
        ? fs.readFileSync(deletedLog, 'utf8').trim().split('\n').filter(Boolean)
        : [];
      return { stdout, deleted };
    }
  };
}

/**
 * Builds a fixture shaped like the real registry: each build contributes one
 * tagged version plus two untagged attestations, all with distinct digests and
 * timestamps within the same second or two.
 */
function builds(count: number, options: { latestOn?: number } = {}): Row[] {
  const latestOn = options.latestOn ?? count - 1;
  const rows: Row[] = [];
  const base = Date.UTC(2026, 9, 20, 1, 0, 0) / 1000; // 2026-10-20T01:00:00Z

  for (let i = 0; i < count; i++) {
    // Builds three hours apart, far wider than the clustering gap.
    const at = base + i * 3 * 3600;
    const iso = (offset: number) =>
      new Date((at + offset) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

    const tags = i === latestOn ? `sha-${i},latest,main` : `sha-${i},main`;
    rows.push([`${1000 + i * 10 + 1}`, iso(1), `sha256:digest-${i}-a`, tags]);
    rows.push([`${1000 + i * 10 + 2}`, iso(1), `sha256:digest-${i}-b`, '']);
    rows.push([`${1000 + i * 10 + 3}`, iso(0), `sha256:digest-${i}-c`, '']);
  }
  return rows;
}

const idsOf = (deleted: string[]) => deleted.map((line) => Number(line.split('/').pop()));

test('GHCR prune groups the versions of one build into one build', async (t) => {
  await t.test('three versions of a single push count as one build, not three', () => {
    // This is the real-registry failure mode: digest-based grouping reported
    // "9 version(s) across 9 image build(s)".
    const h = harness(builds(3));
    const { stdout, deleted } = h.run({ keep: '5' });

    assert.match(stdout, /Found 9 version\(s\) across 3 image build\(s\)/);
    assert.match(stdout, /Nothing to prune/);
    assert.deepEqual(deleted, []);
  });

  await t.test('keeps five builds and drops every version of the sixth', () => {
    const h = harness(builds(6));
    const { stdout, deleted } = h.run({ keep: '5' });

    assert.match(stdout, /Found 18 version\(s\) across 6 image build\(s\)/);
    // The oldest build is three versions that must go together.
    assert.deepEqual(idsOf(deleted).sort((a, b) => a - b), [1001, 1002, 1003]);
  });

  await t.test('never deletes a version belonging to a kept build', () => {
    const h = harness(builds(6));
    const { deleted } = h.run({ keep: '5' });
    for (const id of idsOf(deleted)) {
      assert.ok(id < 1011, `deleted a version from a build that should be kept: ${id}`);
    }
  });

  await t.test('keeping one build deletes the other five builds entirely', () => {
    // Pins the regression: a version-based count of "1" would delete 17 of 18.
    const h = harness(builds(6));
    const { deleted } = h.run({ keep: '1' });
    assert.strictEqual(deleted.length, 15, '5 dropped builds x 3 versions each');
  });

  await t.test('a build spanning a second stays one build', () => {
    // Attestations land a second after the manifest; the cluster gap must not
    // be so tight that a normal push is split in two.
    const rows: Row[] = [
      ['2001', '2026-10-23T07:49:44Z', 'sha256:x1', 'latest,main'],
      ['2002', '2026-10-23T07:49:44Z', 'sha256:x2', ''],
      ['2003', '2026-10-23T07:49:43Z', 'sha256:x3', ''],
      ['2011', '2026-10-23T06:43:31Z', 'sha256:y1', 'sha-45693c3'],
      ['2012', '2026-10-23T06:43:31Z', 'sha256:y2', ''],
      ['2013', '2026-10-23T06:43:30Z', 'sha256:y3', '']
    ];
    const h = harness(rows);
    const { stdout } = h.run({ keep: '5' });
    assert.match(stdout, /across 2 image build\(s\)/);
  });

  await t.test('never deletes the build carrying the latest tag', () => {
    // Drift: the oldest build (build 0) still holds `latest`, which puts it
    // outside the newest two and therefore on the deletion list.
    const h = harness(builds(4, { latestOn: 0 }));
    const { stdout, deleted } = h.run({ keep: '2' });

    // The whole build survives, not just the tagged version: removing the
    // attestations of an image that `latest` still points at would leave an
    // inconsistent build behind.
    for (const id of [1001, 1002, 1003]) {
      assert.ok(!idsOf(deleted).includes(id), `build carrying latest lost version ${id}`);
      assert.match(stdout, new RegExp(`Skipping version ${id}`));
    }

    // The next build is still pruned normally.
    assert.deepEqual(idsOf(deleted).sort((a, b) => a - b), [1011, 1012, 1013]);
  });
});

test('GHCR prune is safe at the boundaries', async (t) => {
  await t.test('does nothing when the build count equals the limit', () => {
    const h = harness(builds(5));
    const { stdout, deleted } = h.run({ keep: '5' });
    assert.match(stdout, /Nothing to prune/);
    assert.deepEqual(deleted, []);
  });

  await t.test('does nothing when there are fewer builds than the limit', () => {
    const h = harness(builds(2));
    const { stdout, deleted } = h.run({ keep: '5' });
    assert.match(stdout, /Nothing to prune/);
    assert.deepEqual(deleted, []);
  });

  await t.test('handles an empty registry', () => {
    const h = harness([]);
    const { stdout, deleted } = h.run({ keep: '5' });
    assert.match(stdout, /No published versions found/);
    assert.deepEqual(deleted, []);
  });

  await t.test('dry run reports without deleting', () => {
    const h = harness(builds(6));
    const { stdout, deleted } = h.run({ keep: '5', dryRun: true });
    assert.match(stdout, /\[dry-run\] Would delete version 1001/);
    assert.deepEqual(deleted, [], 'dry run must not issue any DELETE');
  });

  await t.test('rejects a keep count that would delete everything', () => {
    const h = harness(builds(6));
    // The script reports on stdout and exits 1; execFileSync captures stdout.
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

  await t.test('rejects a non-numeric keep count', () => {
    const h = harness(builds(6));
    assert.throws(() => h.run({ keep: 'five' }), (error: unknown) => {
      const e = error as { status?: number };
      assert.strictEqual(e.status, 1);
      return true;
    });
  });
});
