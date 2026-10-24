import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { bundledIsNewer, reconcileCatalogFiles } from '@/lib/catalogReconcile';

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fy-reconcile-'));
  const dataFile = path.join(dir, 'data', 'courses_db.json');
  const srcFile = path.join(dir, 'src', 'courses_db.json');
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  fs.mkdirSync(path.dirname(srcFile), { recursive: true });
  return { dir, dataFile, srcFile };
}

const catalog = (generated_at: string | undefined, n: number, extra: Record<string, unknown> = {}) => ({
  ...(generated_at ? { generated_at } : {}),
  total_courses: n,
  courses: Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `c${i + 1}` })),
  ...extra
});

const write = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value));
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf-8'));
const idle = () => false;

test('catalog reconcile — a newer, smaller scan result is never overwritten', () => {
  // The regression: a heal merged 684 -> 680 courses; the image still bundles
  // the older 684. Count-based logic replaced the newer catalog on the next GET.
  const { dir, dataFile, srcFile } = sandbox();
  try {
    write(dataFile, catalog('2026-10-22 03:00:00', 680));
    write(srcFile, catalog('2026-10-01 00:00:00', 684));
    assert.strictEqual(reconcileCatalogFiles({ dataFile, srcFile, isRunActive: idle }), 'skipped-not-newer');
    assert.strictEqual(read(dataFile).courses.length, 680);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('catalog reconcile — a genuinely newer bundle upgrades and keeps bookkeeping', () => {
  const { dir, dataFile, srcFile } = sandbox();
  try {
    write(dataFile, catalog('2026-10-01 00:00:00', 684, { last_auto_healed_at: 'X', total_repaired_courses: 7 }));
    write(srcFile, catalog('2026-10-22 00:00:00', 650));
    assert.strictEqual(reconcileCatalogFiles({ dataFile, srcFile, isRunActive: idle }), 'upgraded');
    const after = read(dataFile);
    assert.strictEqual(after.courses.length, 650, 'newer wins even when it has fewer courses');
    assert.strictEqual(after.last_auto_healed_at, 'X');
    assert.strictEqual(after.total_repaired_courses, 7);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(dataFile)), ['courses_db.json'], 'no temp residue');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('catalog reconcile — guards', async (t) => {
  await t.test('seeds a missing live catalog', () => {
    const { dir, dataFile, srcFile } = sandbox();
    try {
      fs.rmSync(path.dirname(dataFile), { recursive: true });
      write(srcFile, catalog('2026-10-01 00:00:00', 3));
      assert.strictEqual(reconcileCatalogFiles({ dataFile, srcFile, isRunActive: idle }), 'seeded');
      assert.strictEqual(read(dataFile).courses.length, 3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('a newer but malformed bundle is ignored', () => {
    const { dir, dataFile, srcFile } = sandbox();
    try {
      write(dataFile, catalog('2026-10-01 00:00:00', 3));
      write(srcFile, { generated_at: '2026-10-22 00:00:00', total_courses: 900, courses: [{ name: 'no id' }] });
      assert.strictEqual(reconcileCatalogFiles({ dataFile, srcFile, isRunActive: idle }), 'skipped-unusable');
      assert.strictEqual(read(dataFile).courses.length, 3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('a running maintenance job blocks the upgrade', () => {
    const { dir, dataFile, srcFile } = sandbox();
    try {
      write(dataFile, catalog('2026-10-01 00:00:00', 3));
      write(srcFile, catalog('2026-10-22 00:00:00', 5));
      assert.strictEqual(reconcileCatalogFiles({ dataFile, srcFile, isRunActive: () => true }), 'skipped-busy');
      assert.strictEqual(read(dataFile).courses.length, 3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('legacy unstamped catalogs fall back to the course count', () => {
    assert.strictEqual(bundledIsNewer(catalog(undefined, 5), catalog(undefined, 3)), true);
    assert.strictEqual(bundledIsNewer(catalog(undefined, 3), catalog(undefined, 5)), false);
    // A stamped live file is never replaced by an unstamped bundle.
    assert.strictEqual(bundledIsNewer(catalog(undefined, 900), catalog('2026-01-01 00:00:00', 1)), false);
  });
});

test('GET /api/courses no longer mutates the catalog; boot does the reconcile', () => {
  const route = fs.readFileSync(path.join(process.cwd(), 'src/app/api/courses/route.ts'), 'utf-8');
  for (const write of ['writeFileSync', 'renameSync', 'copyFileSync', 'reconcileCatalogFiles']) {
    assert.ok(!route.includes(write), `route must not call ${write}`);
  }
  const boot = fs.readFileSync(path.join(process.cwd(), 'src/instrumentation.ts'), 'utf-8');
  assert.match(boot, /reconcileCatalogFiles\(\)/);
});
