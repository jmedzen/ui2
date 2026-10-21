import test from 'node:test';
import assert from 'node:assert';

import {
  TOTP_PERIOD_SECONDS,
  buildTotpUri,
  generateTotpCode,
  generateTotpSecret,
  normalizeTotpSecret,
  parseTotpSecret,
  resetTotpReplayForTests,
  verifyAndConsumeTotpCode,
  verifyTotpCode
} from '@/lib/totp';

// RFC 6238 Appendix B, SHA-1 seed: ASCII "12345678901234567890".
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('TOTP — base32 normalisation and validation', () => {
  assert.strictEqual(normalizeTotpSecret('jbsw y3dp-ehpk3pxp=='), 'JBSWY3DPEHPK3PXP');

  const parsed = parseTotpSecret('jbsw y3dp ehpk 3pxp');
  assert.strictEqual(parsed.ok, true);
  if (parsed.ok) {
    assert.strictEqual(parsed.secret, 'JBSWY3DPEHPK3PXP');
    assert.strictEqual(parsed.bytes.toString('hex'), '48656c6c6f21deadbeef');
  }

  assert.strictEqual(parseTotpSecret('not-base32!').ok, false);
  assert.strictEqual(parseTotpSecret('AAAA').ok, false, 'too short');
});

test('TOTP — generated secrets are valid and round-trip', () => {
  const secret = generateTotpSecret();
  assert.match(secret, /^[A-Z2-7]+$/);
  assert.strictEqual(parseTotpSecret(secret).ok, true);
  assert.strictEqual(secret.length, 32, '160-bit default');
});

test('TOTP — RFC 6238 SHA-1 vectors (6-digit truncation)', () => {
  const vectors: Array<[number, string]> = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130']
  ];

  for (const [seconds, expected] of vectors) {
    assert.strictEqual(
      generateTotpCode(RFC_SECRET, seconds * 1000),
      expected,
      `RFC vector at ${seconds}s`
    );
  }
});

test('TOTP — verification accepts clock skew but not a distant code', () => {
  resetTotpReplayForTests();
  const now = 1_700_000_000_000;
  const current = generateTotpCode(RFC_SECRET, now);
  const previous = generateTotpCode(RFC_SECRET, now - TOTP_PERIOD_SECONDS * 1000);
  const distant = generateTotpCode(RFC_SECRET, now - TOTP_PERIOD_SECONDS * 4 * 1000);

  assert.deepStrictEqual(verifyTotpCode(RFC_SECRET, current, { now }), {
    ok: true,
    step: Math.floor(now / 1000 / TOTP_PERIOD_SECONDS)
  });
  assert.strictEqual(verifyTotpCode(RFC_SECRET, previous, { now }).ok, true);
  assert.strictEqual(verifyTotpCode(RFC_SECRET, distant, { now }).ok, false);
  assert.strictEqual(verifyTotpCode(RFC_SECRET, 'abcdef', { now }).ok, false);
});

test('TOTP — replay guard rejects a reused code and accepts the next step', () => {
  resetTotpReplayForTests();
  const now = 1_700_000_000_000;
  const current = generateTotpCode(RFC_SECRET, now);

  const first = verifyAndConsumeTotpCode(RFC_SECRET, current, { now });
  assert.strictEqual(first.ok, true);

  const replay = verifyAndConsumeTotpCode(RFC_SECRET, current, { now });
  assert.deepStrictEqual(replay, { ok: false, reason: 'replay' });

  const next = generateTotpCode(RFC_SECRET, now + TOTP_PERIOD_SECONDS * 1000);
  const accepted = verifyAndConsumeTotpCode(RFC_SECRET, next, {
    now: now + TOTP_PERIOD_SECONDS * 1000
  });
  assert.strictEqual(accepted.ok, true);
});

test('TOTP — provisioning URI contains the standard parameters', () => {
  const uri = buildTotpUri(RFC_SECRET, { issuer: 'Fayun UI2', account: 'admin' });
  const parsed = new URL(uri);

  assert.strictEqual(parsed.protocol, 'otpauth:');
  assert.strictEqual(parsed.host, 'totp');
  assert.strictEqual(decodeURIComponent(parsed.pathname.replace(/^\//, '')), 'Fayun UI2:admin');
  assert.strictEqual(parsed.searchParams.get('secret'), RFC_SECRET);
  assert.strictEqual(parsed.searchParams.get('issuer'), 'Fayun UI2');
  assert.strictEqual(parsed.searchParams.get('algorithm'), 'SHA1');
  assert.strictEqual(parsed.searchParams.get('digits'), '6');
  assert.strictEqual(parsed.searchParams.get('period'), '30');
});
