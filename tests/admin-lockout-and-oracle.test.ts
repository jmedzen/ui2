import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { createScryptHash, writeAdminCredentialFile } from '@/lib/adminPassword';
import {
  createDeviceCookieValue,
  resetAdminSessionsForTests,
  verifyDeviceCookie
} from '@/lib/adminSession';
import { resetAdminLoginRateLimitForTests } from '@/lib/adminRateLimit';
import { authorizePreloadRequest } from '@/lib/serverTasks';
import { generateTotpCode, generateTotpSecret, resetTotpReplayForTests } from '@/lib/totp';
import { POST as login } from '@/app/api/admin/login/route';
import { POST as manageTotp } from '@/app/api/admin/totp/route';
import { POST as changePassword } from '@/app/api/admin/password/route';
import { GET as sessionStatus } from '@/app/api/admin/session/route';

const PASSWORD = 'correct horse battery staple';
const HASH = createScryptHash(PASSWORD, { N: 1 << 14 });
const HOST = 'http://localhost:8410';

const KEYS = [
  'ADMIN_PASSWORD_HASH', 'ADMIN_PASSWORD_HASH_FILE', 'ADMIN_PASSWORD_FILE', 'ADMIN_TOTP_SECRET',
  'ADMIN_AUDIT_LOG', 'ADMIN_ALLOW_INSECURE_HTTP', 'ADMIN_COOKIE_SECURE', 'ADMIN_LOGIN_MAX_ATTEMPTS',
  'ADMIN_LOGIN_GLOBAL_FAILURES', 'ADMIN_ALLOWED_ORIGINS', 'TASK_API_TOKEN', 'TRUST_PROXY', 'NODE_ENV'
];

function setup(t: test.TestContext, options: { totp?: boolean } = {}) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui2-lockout-'));
  const file = path.join(dir, 'admin.json');
  const secret = options.totp ? generateTotpSecret() : undefined;
  writeAdminCredentialFile(file, { passwordHash: HASH, ...(secret ? { totpSecret: secret } : {}) });
  const env = process.env as Record<string, string | undefined>;
  for (const k of KEYS) delete env[k];
  Object.assign(env, {
    ADMIN_PASSWORD_FILE: file,
    ADMIN_AUDIT_LOG: 'off',
    ADMIN_ALLOW_INSECURE_HTTP: '1',
    ADMIN_COOKIE_SECURE: 'false'
  });
  resetAdminSessionsForTests();
  resetAdminLoginRateLimitForTests();
  resetTotpReplayForTests();
  t.after(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete env[k];
      else env[k] = saved[k];
    }
    resetAdminSessionsForTests();
    resetAdminLoginRateLimitForTests();
    resetTotpReplayForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { file, secret: secret as string };
}

function req(url: string, body: unknown, extra: Record<string, string> = {}): Request {
  return new Request(`${HOST}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: HOST, 'x-admin-request': '1', ...extra },
    body: JSON.stringify(body)
  });
}

/** Every Set-Cookie value as `name=value`. */
function cookies(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of res.headers.getSetCookie()) {
    const pair = line.split(';')[0];
    const eq = pair.indexOf('=');
    out[pair.slice(0, eq)] = pair;
  }
  return out;
}

const codeOf = async (res: Response) => ((await res.json()) as { code?: string }).code;

/* ------------------------------------------------------------------ *
 * #11: no password oracle when 2FA is enabled
 * ------------------------------------------------------------------ */

test('2FA login gives an attacker no signal about the password', async (t) => {
  const { secret } = setup(t, { totp: true });

  // Without a code, right and wrong passwords get the SAME answer (the old
  // order answered TOTP_REQUIRED only for a correct password).
  const right = await login(req('/api/admin/login', { password: PASSWORD }));
  const wrong = await login(req('/api/admin/login', { password: 'definitely wrong' }));
  assert.strictEqual(right.status, 401);
  assert.deepStrictEqual(await right.json(), await wrong.json());

  // With a code, every failure combination is indistinguishable.
  const bodies: unknown[] = [];
  for (const body of [
    { password: 'definitely wrong', code: generateTotpCode(secret) },
    { password: PASSWORD, code: '000000' === generateTotpCode(secret) ? '111111' : '000000' }
  ]) {
    const res = await login(req('/api/admin/login', body));
    assert.strictEqual(res.status, 401);
    bodies.push(await res.json());
  }
  assert.deepStrictEqual(bodies[0], bodies[1]);
  assert.strictEqual((bodies[0] as { code: string }).code, 'ADMIN_BAD_CREDENTIALS');

  const code = generateTotpCode(secret);
  assert.strictEqual((await login(req('/api/admin/login', { password: PASSWORD, code }))).status, 200);
  // A replay no longer confirms the password either.
  assert.strictEqual(await codeOf(await login(req('/api/admin/login', { password: PASSWORD, code }))), 'ADMIN_BAD_CREDENTIALS');
});

test('without 2FA the plain bad-password answer is unchanged', async (t) => {
  setup(t);
  assert.strictEqual(await codeOf(await login(req('/api/admin/login', { password: 'nope nope' }))), 'ADMIN_BAD_PASSWORD');
});

/* ------------------------------------------------------------------ *
 * #9: a failure flood cannot lock out a known browser
 * ------------------------------------------------------------------ */

test('trusted-device cookie survives a global failure flood', async (t) => {
  const { file } = setup(t);
  process.env.ADMIN_LOGIN_GLOBAL_FAILURES = '10';
  process.env.ADMIN_LOGIN_MAX_ATTEMPTS = '100';

  const first = await login(req('/api/admin/login', { password: PASSWORD }));
  assert.strictEqual(first.status, 200);
  const jar = cookies(first);
  assert.ok(jar.fayun_admin_session, 'session cookie still issued first');
  assert.ok(jar.fayun_admin_device, 'a device cookie is issued on success');
  const deviceLine = first.headers.getSetCookie().find((l) => l.startsWith('fayun_admin_device='))!;
  assert.match(deviceLine, /Path=\/api\/admin/);
  assert.match(deviceLine, /HttpOnly/);
  assert.match(deviceLine, /SameSite=Strict/);

  // The attacker's flood exhausts the global ceiling.
  for (let i = 0; i < 10; i++) {
    await login(req('/api/admin/login', { password: `wrong-${i}` }));
  }
  const anonymous = await login(req('/api/admin/login', { password: PASSWORD }));
  assert.strictEqual(anonymous.status, 429, 'an unknown browser is still throttled');

  const known = await login(req('/api/admin/login', { password: PASSWORD }, { cookie: jar.fayun_admin_device }));
  assert.strictEqual(known.status, 200, 'the administrator\'s browser is not locked out');

  // An authenticated admin can still manage the password during the flood.
  const sessionCookie = cookies(known).fayun_admin_session;
  const change = await changePassword(
    req('/api/admin/password', { currentPassword: 'wrong-current', newPassword: 'another long password' }, { cookie: sessionCookie })
  );
  assert.strictEqual(change.status, 401, 'reaches the password check instead of a global 429');

  // Rotating the password revokes every device cookie (the MAC key is derived from the hash).
  writeAdminCredentialFile(file, { passwordHash: createScryptHash('a different password', { N: 1 << 14 }) });
  const afterRotation = await login(req('/api/admin/login', { password: 'a different password' }, { cookie: jar.fayun_admin_device }));
  assert.strictEqual(afterRotation.status, 429);
});

test('device cookies are tamper-proof and expire', () => {
  const value = createDeviceCookieValue(HASH, 1_000_000);
  const asReq = (v: string) => new Request(HOST, { headers: { cookie: `fayun_admin_device=${v}` } });
  assert.ok(verifyDeviceCookie(asReq(value), HASH, 1_000_000 + 1000));
  assert.strictEqual(verifyDeviceCookie(asReq(value), 'scrypt:other', 1_000_000), null, 'bound to the hash');
  assert.strictEqual(verifyDeviceCookie(asReq(value.slice(0, -2) + 'AA'), HASH, 1_000_000), null, 'MAC checked');
  assert.strictEqual(verifyDeviceCookie(asReq(value), HASH, 1_000_000 + 91 * 86_400_000), null, 'expires after 90 days');
  assert.strictEqual(verifyDeviceCookie(asReq('garbage'), HASH), null);
});

/* ------------------------------------------------------------------ *
 * #10: enabling 2FA revokes password-only sessions
 * ------------------------------------------------------------------ */

test('enabling TOTP revokes every other session but keeps the current one', async (t) => {
  setup(t);
  const a = cookies(await login(req('/api/admin/login', { password: PASSWORD }))).fayun_admin_session;
  const b = cookies(await login(req('/api/admin/login', { password: PASSWORD }))).fayun_admin_session;

  const setupRes = await manageTotp(req('/api/admin/totp', { action: 'setup' }, { cookie: a }));
  const { secret } = (await setupRes.json()) as { secret: string };
  const enable = await manageTotp(
    req('/api/admin/totp', { action: 'enable', secret, password: PASSWORD, code: generateTotpCode(secret) }, { cookie: a })
  );
  assert.strictEqual(enable.status, 200, await enable.clone().text());

  const status = async (cookie: string) =>
    ((await (await sessionStatus(new Request(`${HOST}/api/admin/session`, { headers: { cookie } }))).json()) as { authenticated: boolean }).authenticated;
  assert.strictEqual(await status(a), true, 'the session that enrolled stays signed in');
  assert.strictEqual(await status(b), false, 'a password-only session is revoked');
});

/* ------------------------------------------------------------------ *
 * #8: X-Forwarded-Host honoured only behind a trusted proxy
 * ------------------------------------------------------------------ */

test('X-Forwarded-Host is ignored unless TRUST_PROXY=1', async (t) => {
  setup(t);
  const spoof = { origin: 'https://evil.example', 'x-forwarded-host': 'evil.example' };

  const direct = await login(req('/api/admin/login', { password: PASSWORD }, spoof));
  assert.strictEqual(direct.status, 403, 'a caller must not choose the host its Origin is compared to');

  const preload = authorizePreloadRequest(new Request(`${HOST}/api/proxy`, { headers: spoof }));
  assert.strictEqual(preload.ok, false);

  process.env.TRUST_PROXY = '1';
  resetAdminLoginRateLimitForTests();
  const proxied = await login(
    req('/api/admin/login', { password: PASSWORD }, { origin: 'https://ui2.example', 'x-forwarded-host': 'ui2.example' })
  );
  assert.strictEqual(proxied.status, 200, 'behind a trusted proxy the forwarded host is used');
});
