import './helpers/isolated-media-cache';

import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

/**
 * Python-side regression tests.
 *
 * Everything here runs OFFLINE against a throwaway tree: the scripts are
 * imported (not executed as a scan) and their network entry points are
 * monkeypatched, so nothing touches fayun.org and no real catalog is written.
 */

const REPO = process.cwd();
const SCRIPTS = path.join(REPO, 'scripts');

/** Runs a small Python program with a disposable FAYUN_PROJECT_DIR. */
function runPython(body: string, withSrcCopy = true): { code: number; out: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fayun-py-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'data'), { recursive: true });
  if (withSrcCopy) {
    fs.copyFileSync(
      path.join(REPO, 'src', 'data', 'courses_db.json'),
      path.join(root, 'src', 'data', 'courses_db.json')
    );
  }

  const program = [
    'import os, sys, json',
    `os.environ["FAYUN_PROJECT_DIR"] = ${JSON.stringify(root)}`,
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
    body
  ].join('\n');

  const res = spawnSync('python3', ['-c', program], {
    cwd: REPO,
    encoding: 'utf-8',
    env: { ...process.env, FAYUN_PROJECT_DIR: root, TASK_LOG_DIR: path.join(root, 'data', 'logs') }
  });
  fs.rmSync(root, { recursive: true, force: true });
  return { code: res.status ?? -1, out: `${res.stdout || ''}${res.stderr || ''}` };
}

test('python — shared module compiles and both scripts import cleanly', () => {
  for (const f of ['media_common.py', 'scan_fayun.py', 'auto_heal_catalog.py']) {
    const res = spawnSync('python3', ['-m', 'py_compile', path.join(SCRIPTS, f)], {
      cwd: REPO,
      encoding: 'utf-8'
    });
    assert.strictEqual(res.status, 0, `${f} must compile: ${res.stderr}`);
  }
});

/* ------------------------------------------------------------------ *
 * Log rotation: the off-by-one deleted a generation instead of shifting
 * ------------------------------------------------------------------ */

test('python — log rotation keeps every backup generation', () => {
  const { code, out } = runPython(
    [
      'import media_common as mc',
      'mc.ensure_dirs()',
      'mc.LOG_MAX_BYTES = 0  # force a roll on every call',
      'states = []',
      'for gen in range(1, 6):',
      '    open(mc.LOG_PATH, "a").write(f"GEN{gen}\\n")',
      '    mc.rotate_log_if_needed()',
      '    row = []',
      '    for n in (1, 2, 3):',
      '        p = f"{mc.LOG_PATH}.{n}"',
      '        row.append(open(p).read().strip() if os.path.exists(p) else None)',
      '    states.append(row)',
      'print(json.dumps(states))'
    ].join('\n')
  );
  assert.strictEqual(code, 0, `python failed: ${out}`);
  const states = JSON.parse(out.trim().split('\n').pop() as string) as (string | null)[][];

  // The third generation must actually be created; the old loop deleted .2 and
  // never produced .3 at all.
  assert.deepStrictEqual(states[2], ['GEN3', 'GEN2', 'GEN1'], 'all three generations must exist');
  assert.deepStrictEqual(states[4], ['GEN5', 'GEN4', 'GEN3'], 'rotation must keep shifting forward');
});

/* ------------------------------------------------------------------ *
 * Corrupt-catalog recovery
 * ------------------------------------------------------------------ */

test('python — a corrupt catalog is quarantined and recovered, never fatal', () => {
  const { code, out } = runPython(
    [
      'import media_common as mc',
      'mc.ensure_dirs()',
      '# Truncated JSON, as an interrupted write would leave.',
      'open(mc.DB_PATH, "w").write(\'{"courses": [{"id": 1\')',
      'data, source = mc.load_catalog()',
      'print(source, len(data.get("courses", [])))',
      'print("quarantined:", [f for f in os.listdir(mc.DATA_DIR) if "corrupt" in f])'
    ].join('\n')
  );
  assert.strictEqual(code, 0, `must not crash on a truncated catalog: ${out}`);
  assert.match(out, /src 684/, 'must recover the catalog from the bundled copy');
  assert.match(out, /quarantined: \[.*corrupt/, 'the bad file must be moved aside');
});

test('python — a non-object catalog does not raise AttributeError', () => {
  const { code, out } = runPython(
    [
      'import media_common as mc',
      'mc.ensure_dirs()',
      'open(mc.DB_PATH, "w").write("[]")  # valid JSON, wrong shape',
      'data, source = mc.load_catalog()',
      'print(source, len(data.get("courses", [])))'
    ].join('\n')
  );
  assert.strictEqual(code, 0, `a JSON array must not crash the loader: ${out}`);
  assert.match(out, /src 684/);
});

/* ------------------------------------------------------------------ *
 * Atomic write: unique temp names + surrogate safety
 * ------------------------------------------------------------------ */

test('python — concurrent writers never publish a spliced catalog', () => {
  const { code, out } = runPython(
    [
      'import media_common as mc, threading, json, os',
      'mc.ensure_dirs()',
      'mc.write_json_atomic(mc.DB_PATH, {"courses": []})',
      'errors = []',
      'def writer(n, count):',
      '    try:',
      '        for _ in range(25):',
      '            mc.write_json_atomic(mc.DB_PATH, {"courses": [{"id": i} for i in range(count)]})',
      '    except Exception as e:',
      '        errors.append(f"{type(e).__name__}")',
      'threads = [threading.Thread(target=writer, args=(1, 4000)), threading.Thread(target=writer, args=(2, 7))]',
      '[t.start() for t in threads]',
      '[t.join() for t in threads]',
      'final = json.load(open(mc.DB_PATH))',
      'n = len(final["courses"])',
      'print("count", n, "whole", n in (7, 4000), "errors", errors)'
    ].join('\n')
  );
  assert.strictEqual(code, 0, `concurrent writes must not raise fatally: ${out}`);
  assert.match(out, /whole True/, `published file must be one whole payload, not spliced: ${out}`);
});

test('python — lone surrogates do not abort the write', () => {
  const { code, out } = runPython(
    [
      'import media_common as mc, json',
      'mc.ensure_dirs()',
      '# json.loads accepts an escaped lone surrogate, but ensure_ascii=False',
      '# cannot encode it to UTF-8 -- this used to abort after all the scan work.',
      'payload = json.loads(\'{"courses": [], "n": "a\\\\ud83d"}\')',
      'mc.write_json_atomic(mc.DB_PATH, payload)',
      'print("wrote", len(json.load(open(mc.DB_PATH))["courses"]))'
    ].join('\n')
  );
  assert.strictEqual(code, 0, `a lone surrogate must not abort the write: ${out}`);
  assert.match(out, /wrote 0/);
});

/* ------------------------------------------------------------------ *
 * Exclusive lock
 * ------------------------------------------------------------------ */

test('python — a second process cannot take the catalog lock', () => {
  const { code, out } = runPython(
    [
      'import media_common as mc, subprocess, sys, os',
      'mc.ensure_dirs()',
      'with mc.catalog_lock():',
      '    child = subprocess.run([sys.executable, "-c", f"""',
      'import os, sys',
      'sys.path.insert(0, {SCRIPTS!r})',
      'import media_common as mc',
      'try:',
      '    with mc.catalog_lock():',
      '        print("BOTH")',
      'except mc.CatalogBusy:',
      '    print("REFUSED")',
      '"""], capture_output=True, text=True, env={**os.environ})',
      '    print(child.stdout.strip() or child.stderr.strip())'
    ]
      .join('\n')
      .replace('{SCRIPTS!r}', JSON.stringify(SCRIPTS))
  );
  assert.strictEqual(code, 0, `lock probe failed: ${out}`);
  assert.match(out, /REFUSED/, `a second process must be refused: ${out}`);
  assert.doesNotMatch(out, /BOTH/, 'two processes must never hold the lock at once');
});

/* ------------------------------------------------------------------ *
 * scan_fayun behaviour under failure
 * ------------------------------------------------------------------ */

test('python — an all-categories failure keeps the catalog and exits non-zero', () => {
  const { code, out } = runPython(
    [
      'import media_common as mc, scan_fayun as sf, json, shutil',
      'mc.ensure_dirs()',
      '# Seed a previously published catalog: this is the file a failed scan used',
      '# to overwrite (with just the preserved rows) while reporting success.',
      'shutil.copyfile(mc.SRC_DB_PATH, mc.DB_PATH)',
      'raw_before = open(mc.DB_PATH).read()',
      'sf.fetch_category_media = lambda m, s: (_ for _ in ()).throw(RuntimeError("network down"))',
      'rc = sf.main()',
      'kept = open(mc.DB_PATH).read() == raw_before',
      '# The bundled copy must also be untouched, since it is the recovery source.',
      'src_intact = len(json.load(open(mc.SRC_DB_PATH))["courses"]) == 684',
      'print("rc", rc, "kept", kept, "src_intact", src_intact)'
    ].join('\n')
  );
  assert.strictEqual(code, 0, out);
  // A total upstream failure must not be reported as success.
  assert.match(out, /rc 1/, `expected exit 1, got: ${out}`);
  assert.match(out, /kept True/, 'the published catalog must be left byte-identical');
  assert.match(out, /src_intact True/, 'the bundled recovery copy must be untouched');
});

test('python — one malformed item does not discard its category', () => {
  const { code, out } = runPython(
    [
      'import media_common as mc, scan_fayun as sf, json',
      'mc.ensure_dirs()',
      'items = [',
      '  {"id": 9001, "name": "ok", "topic": "ahanjing", "total": 3, "audio_path": "/x/audio"},',
      '  {"id": None, "name": "no id"},',
      '  "not-a-dict",',
      '  {"id": 9002, "name": None, "topic": "ahanjing", "total": 2},',
      ']',
      'sf.fetch_category_media = lambda m, s: items if (m, s) == ("dharma", "jing") else []',
      'rc = sf.main()',
      'ids = {c["id"] for c in json.load(open(mc.DB_PATH))["courses"]}',
      'print("rc", rc, "has_9001", 9001 in ids, "has_9002", 9002 in ids)'
    ].join('\n')
  );
  assert.strictEqual(code, 0, out);
  assert.match(out, /has_9001 True/, 'a valid item before the bad one must survive');
  assert.match(out, /has_9002 True/, 'a valid item after the bad one must survive too');
});

test('python — PATH_OVERRIDES wins over the stored path', () => {
  const { code, out } = runPython(
    [
      'import media_common as mc, scan_fayun as sf, json',
      'mc.ensure_dirs()',
      'sf.PATH_OVERRIDES = {9001: {"audio_path": "/override/audio"}}',
      'item = {"id": 9001, "name": "ok", "topic": "ahanjing", "total": 3, "audio_path": "/api/audio"}',
      'sf.fetch_category_media = lambda m, s: [item] if (m, s) == ("dharma", "jing") else []',
      'sf.main()',
      'sf.main()  # second run: 9001 now EXISTS, so the override must still apply',
      'c = [x for x in json.load(open(mc.DB_PATH))["courses"] if x["id"] == 9001][0]',
      'print("audio", c["audio_path"])'
    ].join('\n')
  );
  assert.strictEqual(code, 0, out);
  // Previously the stored value overwrote the override on the second run.
  assert.match(out, /audio \/override\/audio/, `override must survive a re-scan: ${out}`);
});

test('python — the episode count can grow when upstream reports more', () => {
  const { code, out } = runPython(
    [
      'import media_common as mc, scan_fayun as sf, json',
      'mc.ensure_dirs()',
      'def f(m, s):',
      '    return [{"id": 9001, "name": "ok", "topic": "ahanjing", "total": 42}] if (m, s) == ("dharma", "jing") else []',
      'sf.fetch_category_media = f',
      'sf.main()',
      'c = [x for x in json.load(open(mc.DB_PATH))["courses"] if x["id"] == 9001][0]',
      'print("eps", c["total_episodes"])'
    ].join('\n')
  );
  assert.strictEqual(code, 0, out);
  assert.match(out, /eps 42/, `the count must not stay frozen at an older value: ${out}`);
});

/* ------------------------------------------------------------------ *
 * auto_heal behaviour
 * ------------------------------------------------------------------ */

test('python — PDF repair never wipes a curated list when nothing is found', () => {
  const { code, out } = runPython(
    [
      'import auto_heal_catalog as ah',
      'ah.verify_media_url = lambda u: (False, "HTTP 404")',
      'ah.find_real_pdfs_for_course = lambda c: []',
      'course = {"id": 1, "name": "n", "pdfs": [',
      '  {"num": 1, "url": "https://x/a.pdf"},',
      '  {"num": 2, "url": "https://x/b.pdf"},',
      '  {"num": 3, "url": "https://x/c.pdf"}]}',
      'modified, notes = ah.verify_and_heal_course(course)',
      'print("kept", len(course["pdfs"]), "modified", modified)'
    ].join('\n')
  );
  assert.strictEqual(code, 0, out);
  // 9 real courses (one with 503 PDFs) live in directories the finder cannot
  // reach; an empty finder result must never be treated as "all links are dead".
  assert.match(out, /kept 3/, `the curated list must be preserved: ${out}`);
});

test('python — quote_url is idempotent (no double encoding)', () => {
  const { code, out } = runPython(
    [
      'import auto_heal_catalog as ah',
      'u = "https://www.fayun.org/ftpadmin/media/english/pdf/01.Brif%20Intro.pdf"',
      'once = ah.quote_url(u)',
      'twice = ah.quote_url(once)',
      'print("no_double", "%2520" not in once, "idempotent", once == twice)'
    ].join('\n')
  );
  assert.strictEqual(code, 0, out);
  assert.match(out, /no_double True/);
  assert.match(out, /idempotent True/);
});

test('python — a failed audio probe (None) does not rewrite the path', () => {
  const { code, out } = runPython(
    [
      'import auto_heal_catalog as ah',
      'ah.verify_media_url = lambda u: (True, "ok")',
      'ah.query_remote_list = lambda p: None  # transient network failure',
      'c = {"id": 3, "name": "n", "audio_path": "/media/x/audio", "pdfs": []}',
      'ah.verify_and_heal_course(c)',
      'print("audio", c["audio_path"])'
    ].join('\n')
  );
  assert.strictEqual(code, 0, out);
  // None means "probe failed", [] means "directory is empty". They must differ.
  assert.match(out, /audio \/media\/x\/audio/, `a network blip must not mutate the path: ${out}`);
});

/* ------------------------------------------------------------------ *
 * Auxiliary maintenance scripts
 * ------------------------------------------------------------------ */

test('python — the daemon routes through the shared lock', () => {
  const raw = fs.readFileSync(path.join(SCRIPTS, 'scanner_daemon.py'), 'utf-8');
  // Strip comments: this file's own comments mention run_scan() when explaining
  // why it is NOT called, which would make a naive doesNotMatch fail.
  const src = raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .map((line) => line.replace(/\s+#.*$/, ''))
    .join('\n');
  // Calling run_scan() directly bypassed the catalog lock that /api/scan takes,
  // so a scheduled run could write concurrently with a manual one.
  assert.match(src, /sf\.main\(\)/, 'the daemon must call the locking entry point');
  assert.doesNotMatch(src, /run_scan\(/, 'the daemon must not bypass the lock');

  // The sleep used to live inside the same try as run_scan(), so a scan error
  // skipped it and the daemon hot-looped against the network.
  assert.match(src, /def _sleep/, 'the sleep must be a separate interruptible helper');
  assert.match(src, /rc == mc\.EXIT_BUSY/, 'a busy lock must not cause a hot retry loop');
});

test('python — fix_pdf_urls writes atomically', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'fix_pdf_urls.py'), 'utf-8');
  // A plain open("w") truncates first, so an interrupt destroyed the catalog.
  assert.match(src, /mc\.write_json_atomic\(DB_PATH, db\)/, 'must use the atomic writer');
  assert.doesNotMatch(src, /open\(DB_PATH, "w"/, 'must not truncate the catalog in place');
  assert.match(src, /mc\.load_catalog\(DB_PATH\)/, 'must load tolerantly');
});
