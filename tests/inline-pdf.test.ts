import test from 'node:test';
import assert from 'node:assert';
import { canInlinePdf } from '../src/lib/inlinePdf';

const SAFARI_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

test('inline PDF support detection', async (t) => {
  await t.test('desktop browsers render PDFs inline', () => {
    assert.strictEqual(canInlinePdf({ userAgent: SAFARI_MAC, platform: 'MacIntel', maxTouchPoints: 0 }), true);
    assert.strictEqual(canInlinePdf({ userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120', platform: 'Win32', maxTouchPoints: 0 }), true);
    assert.strictEqual(canInlinePdf({}), true);
  });

  await t.test('iPhone is not inline-capable', () => {
    assert.strictEqual(canInlinePdf({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1', platform: 'iPhone', maxTouchPoints: 5 }), false);
  });

  await t.test('iPadOS, which reports itself as a Mac with a touch screen, is not inline-capable', () => {
    assert.strictEqual(canInlinePdf({ userAgent: SAFARI_MAC, platform: 'MacIntel', maxTouchPoints: 5 }), false);
  });
});
