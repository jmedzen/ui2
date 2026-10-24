import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Runs the real docker-entrypoint.sh with stubbed `id`, `chown` and `su-exec`
 * so its root branch executes without root. The stub chown only records its
 * arguments, which is exactly what we need to prove a symlink is never handed
 * to the unprivileged user.
 */
test('entrypoint never chowns through a symlink (node -> root escalation)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fy-entry-'));
  try {
    const bin = path.join(root, 'bin');
    const data = path.join(root, 'data');
    const outside = path.join(root, 'outside');
    const log = path.join(root, 'chown.log');
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(data, 'logs'), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'passwd'), 'root:x:0:0');
    fs.writeFileSync(path.join(data, 'courses_db.json'), '{}');
    fs.writeFileSync(path.join(data, 'logs', 'scanner.log'), '');
    // What a compromised app process could plant before a restart.
    fs.symlinkSync(path.join(outside, 'passwd'), path.join(data, 'logs', 'evil'));
    fs.symlinkSync(path.join(outside, 'passwd'), path.join(data, '.hidden-evil'));
    fs.symlinkSync(outside, path.join(data, 'media_cache'));

    const stub = (name: string, body: string) => {
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    };
    stub('id', 'case "$*" in "-u node"|"-g node") echo 1000;; "-u") echo 0;; *) /usr/bin/id "$@";; esac');
    stub('chown', `echo "$*" >> '${log}'`);
    stub('su-exec', 'shift; exec "$@"');

    const out = execFileSync('sh', [path.join(process.cwd(), 'docker-entrypoint.sh'), 'echo', 'APP-STARTED'], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DATA_DIR: data },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    assert.match(out, /APP-STARTED/, 'the entrypoint must still exec the app');

    const calls = fs.readFileSync(log, 'utf-8').trim().split('\n');
    assert.ok(calls.length > 0);
    for (const call of calls) {
      assert.ok(call.startsWith('-h '), `every chown must use -h: ${call}`);
      assert.ok(!call.includes('evil') && !call.includes('outside') && !call.endsWith('media_cache'), `symlink was chowned: ${call}`);
    }
    assert.ok(calls.some((c) => c.endsWith('courses_db.json')), 'regular files are still re-owned');
    assert.ok(calls.some((c) => c.endsWith('scanner.log')), 'the log file is still re-owned');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
