import './helpers/isolated-media-cache';

import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

/**
 * Regression tests for the log display refresh bug.
 *
 * Symptom: with a scanner.log that a background run (or the 24h daemon, or
 * another browser) was actively appending to, the log window kept showing the
 * content it had loaded when the modal opened. Two independent causes:
 *
 *   1. the periodic status poll read `recentLogs` and discarded it, updating
 *      only `isRunning`; and
 *   2. the only effect that refreshed the log text was gated on
 *      `isTriggeringScan || isTriggeringHeal`, i.e. it ran solely while THIS
 *      browser was inside a trigger call and stopped as soon as the run ended.
 *
 * The API itself was verified healthy (a new line appended to scanner.log
 * appears in the very next GET /api/scan response, with no caching), so these
 * tests pin the client-side behaviour.
 */

const MODAL = path.join(process.cwd(), 'src', 'components', 'SettingsModal.tsx');

function readModal(): string {
  return fs.readFileSync(MODAL, 'utf-8');
}

/** Strips comments so assertions cannot be satisfied by prose alone. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .map((line) => line.replace(/\s+\/\/.*$/, ''))
    .join('\n');
}

test('log refresh — the modal polls while the log tab is open', async (t) => {
  await t.test('a periodic poll exists that is not gated on a local trigger', () => {
    const code = stripComments(readModal());

    // The poll must be reachable while the logs tab is showing.
    assert.match(code, /activeTab !== 'logs'/, 'the refresh effect must key off the visible tab');
    assert.match(code, /setInterval\(refresh, 3000\)/, 'the log tab must poll on a timer');

    // Regression: the old gate meant the window froze unless this browser had
    // started the run, so a daemon/other-browser/curl run never showed up.
    assert.doesNotMatch(
      code,
      /if \(!isTriggeringScan && !isTriggeringHeal\) return;/,
      'the log poll must not depend on a locally-owned trigger'
    );
  });

  await t.test('the poll writes the log text, not just the running flag', () => {
    const code = stripComments(readModal());
    // The status payload carries recentLogs; discarding it was the whole bug.
    const pollEffect = code.slice(code.indexOf("activeTab !== 'logs'"));
    assert.match(
      pollEffect.slice(0, 900),
      /fetchLogs\(\)/,
      'the polling effect must refresh the log text via fetchLogs'
    );
  });

  await t.test('the interval is cleared on unmount / tab change', () => {
    const code = stripComments(readModal());
    assert.match(code, /clearInterval\(timer\)/, 'the interval must be cleared');
    assert.match(code, /cancelled = true/, 'in-flight responses must be ignored after teardown');
  });
});

test('log refresh — responses are not cacheable', async (t) => {
  await t.test('both status endpoints declare no-store', () => {
    for (const route of ['scan', 'health-check']) {
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src', 'app', 'api', route, 'route.ts'),
        'utf-8'
      );
      // A dynamic GET with no cache directive is still open to heuristic
      // caching by intermediaries, which would freeze the polled body.
      assert.match(src, /Cache-Control': 'no-store/, `${route} must set Cache-Control: no-store`);
      assert.match(src, /\{ headers: NO_STORE \}\)/, `${route} must apply the header to its GET response`);
    }
  });
});

test('log refresh — the trigger notice cannot be erased or duplicated', async (t) => {
  await t.test('the notice is banner state, not spliced into the log buffer', () => {
    const code = stripComments(readModal());
    // Prepending to `logs` was overwritten by the next poll (the server tail does
    // not contain it); concatenating the tail instead duplicated every line on
    // every poll. A separate banner has neither failure mode.
    assert.match(code, /localNotice/, 'the trigger notice must live in its own state');
    assert.doesNotMatch(
      code,
      /setLogs\(\(prev\) => \(prev \? `\$\{prev\}\\n\$\{data\.recentLogs\}`/,
      'the server tail must not be appended to the previous log buffer'
    );
    assert.doesNotMatch(
      code,
      /setLogs\(\(prev\) => \(prev \? `\$\{prev\}\\n\$\{promptMsg\}`/,
      'the trigger message must not be prepended to the log buffer'
    );
  });

  await t.test('the notice is rendered and dismissible', () => {
    const code = readModal();
    assert.match(code, /className="log-notice-bar"/, 'the notice must be rendered');
    assert.match(code, /onClick=\{\(\) => setLocalNotice\(''\)\}/, 'the notice must be dismissible');
  });

  await t.test('the notice clears once the run finishes', () => {
    const code = stripComments(readModal());
    assert.match(code, /if \(finished\) setLocalNotice\(''\)/, 'a finished run must clear the banner');
  });
});

test('log refresh — auto-scroll does not fight the reader', async (t) => {
  await t.test('scrolling up stops the window from following the tail', () => {
    const code = stripComments(readModal());
    // With a 3s refresh, unconditional scrolling would yank the view back to the
    // bottom while the user reads earlier lines.
    assert.match(code, /stickToBottomRef/, 'must track whether the view is pinned to the bottom');
    assert.match(code, /onScroll=\{handleLogScroll\}/, 'the log pane must observe scrolling');
    assert.match(
      code,
      /if \(!stickToBottomRef\.current\) return;/,
      'the auto-scroll effect must respect the pinned state'
    );
  });
});
