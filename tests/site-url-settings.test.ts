import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_SITE_URL,
  clearStoredSiteUrl,
  getSiteSettingsFile,
  normalizeSiteUrl,
  readStoredSiteSettings,
  resolveSiteUrl,
  writeStoredSiteUrl
} from '@/lib/site';

/**
 * Admin-editable canonical URL.
 *
 * The origin behind `<link rel="canonical">` and og:url used to be build-time
 * only, so a domain change meant editing compose and redeploying. Making it
 * editable introduced three ways to get it wrong, and each is covered here:
 * accepting a malformed value (the site then advertises a fake canonical),
 * letting an env var and a stored value disagree silently, and writing the
 * settings file non-atomically so a request reads a half-written file.
 */

/** Point the settings file at a scratch directory for one test. */
function withTempSettings(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui2-site-'));
  const file = path.join(dir, 'site.json');
  const savedFile = process.env.SITE_SETTINGS_FILE;
  const savedUrl = process.env.SITE_URL;

  process.env.SITE_SETTINGS_FILE = file;
  delete process.env.SITE_URL;

  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (savedFile === undefined) delete process.env.SITE_SETTINGS_FILE;
    else process.env.SITE_SETTINGS_FILE = savedFile;
    if (savedUrl === undefined) delete process.env.SITE_URL;
    else process.env.SITE_URL = savedUrl;
  });

  return file;
}

test('canonical url — normalization accepts what an operator actually types', () => {
  // A bare host is the common case; typing the scheme is the exception.
  assert.deepStrictEqual(normalizeSiteUrl('ui2.mahabodhi.co'), {
    ok: true,
    value: 'https://ui2.mahabodhi.co'
  });
  assert.deepStrictEqual(normalizeSiteUrl('  https://ui2.mahabodhi.co  '), {
    ok: true,
    value: 'https://ui2.mahabodhi.co'
  });
  // A trailing slash must not survive into og:url, which would emit a double
  // slash and can fail some platforms' URL validation.
  assert.deepStrictEqual(normalizeSiteUrl('https://ui2.mahabodhi.co/'), {
    ok: true,
    value: 'https://ui2.mahabodhi.co'
  });
  // A non-default port is meaningful and must be kept.
  assert.deepStrictEqual(normalizeSiteUrl('https://example.com:8443'), {
    ok: true,
    value: 'https://example.com:8443'
  });
});

test('canonical url — normalization rejects values that would break the tag', () => {
  // Rejecting rather than silently falling back matters on write: an admin who
  // types garbage must be told, not have the change quietly discarded.
  const rejected = [
    '',
    '   ',
    'not a url',
    'ftp://example.com',
    'mailto:someone@example.com',
    'https://example.com/some/path',
    'https://example.com/?q=1',
    'https://example.com/#frag',
    'https://user:pass@example.com',
    'nodots'
  ];
  for (const value of rejected) {
    const result = normalizeSiteUrl(value);
    assert.strictEqual(result.ok, false, `"${value}" must be rejected`);
    if (!result.ok) assert.ok(result.message.length > 0, 'rejection needs a message');
  }

  // localhost is a legitimate origin for a LAN install even without a dot.
  assert.deepStrictEqual(normalizeSiteUrl('localhost:8410'), {
    ok: true,
    value: 'https://localhost:8410'
  });
});

test('canonical url — resolution order is environment, then settings, then default', (t) => {
  withTempSettings(t);

  // Nothing configured anywhere.
  assert.deepStrictEqual(resolveSiteUrl(), {
    origin: DEFAULT_SITE_URL,
    source: 'default'
  });

  // A stored value wins over the default.
  assert.ok(writeStoredSiteUrl('https://stored.example.org').ok);
  assert.deepStrictEqual(resolveSiteUrl(), {
    origin: 'https://stored.example.org',
    source: 'settings'
  });

  // An explicit env var pins the origin even when a file disagrees, so a
  // deployment can never be silently retargeted by a leftover file.
  process.env.SITE_URL = 'https://env.example.org';
  assert.deepStrictEqual(resolveSiteUrl(), {
    origin: 'https://env.example.org',
    source: 'environment'
  });

  // Clearing the file restores the lower-precedence value.
  delete process.env.SITE_URL;
  assert.ok(clearStoredSiteUrl().ok);
  assert.deepStrictEqual(resolveSiteUrl(), {
    origin: DEFAULT_SITE_URL,
    source: 'default'
  });
});

test('canonical url — a broken settings file degrades to the default, never to garbage', (t) => {
  const file = withTempSettings(t);

  fs.writeFileSync(file, '{ this is not json ');
  assert.deepStrictEqual(readStoredSiteSettings(), { siteUrl: null, updatedAt: null });
  assert.strictEqual(resolveSiteUrl().source, 'default');

  // A hand-edited invalid origin must not be propagated into <link canonical>.
  fs.writeFileSync(file, JSON.stringify({ siteUrl: 'javascript:alert(1)' }));
  assert.strictEqual(readStoredSiteSettings().siteUrl, null);
  assert.strictEqual(resolveSiteUrl().origin, DEFAULT_SITE_URL);

  // Same for a value with a path.
  fs.writeFileSync(file, JSON.stringify({ siteUrl: 'https://example.com/a/b' }));
  assert.strictEqual(readStoredSiteSettings().siteUrl, null);
});

test('canonical url — settings are written atomically with restrictive permissions', (t) => {
  const file = withTempSettings(t);

  assert.ok(writeStoredSiteUrl('https://atomic.example.org').ok);

  const raw = fs.readFileSync(file, 'utf-8');
  const parsed = JSON.parse(raw) as { siteUrl: string; updatedAt: string };
  assert.strictEqual(parsed.siteUrl, 'https://atomic.example.org');
  // The timestamp is what the admin panel shows as "last changed".
  assert.ok(!Number.isNaN(Date.parse(parsed.updatedAt)), 'updatedAt must be a real timestamp');

  // 0600: the file names the deployment's public identity and is written into a
  // directory shared with the admin credential.
  const mode = fs.statSync(file).mode & 0o777;
  assert.strictEqual(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);

  // No temp files may be left behind: the rename must be the only visible step.
  const leftovers = fs
    .readdirSync(path.dirname(file))
    .filter((name) => name.includes('.tmp'));
  assert.deepStrictEqual(leftovers, [], 'atomic write must not leave temp files');

  // Writing twice must replace, not append or corrupt.
  assert.ok(writeStoredSiteUrl('https://second.example.org').ok);
  assert.strictEqual(readStoredSiteSettings().siteUrl, 'https://second.example.org');
});

test('canonical url — the settings path is overridable and defaults into data/', () => {
  const saved = process.env.SITE_SETTINGS_FILE;
  try {
    delete process.env.SITE_SETTINGS_FILE;
    assert.strictEqual(getSiteSettingsFile(), path.join(process.cwd(), 'data', 'site.json'));

    process.env.SITE_SETTINGS_FILE = '/tmp/custom-site.json';
    assert.strictEqual(getSiteSettingsFile(), '/tmp/custom-site.json');

    // Blank must fall back rather than resolving to the cwd.
    process.env.SITE_SETTINGS_FILE = '   ';
    assert.strictEqual(getSiteSettingsFile(), path.join(process.cwd(), 'data', 'site.json'));
  } finally {
    if (saved === undefined) delete process.env.SITE_SETTINGS_FILE;
    else process.env.SITE_SETTINGS_FILE = saved;
  }
});

test('canonical url — clearing an absent file is not an error', (t) => {
  withTempSettings(t);
  // The reset button is idempotent: pressing it when nothing is stored (or
  // twice) must still report success.
  assert.ok(clearStoredSiteUrl().ok);
  assert.ok(clearStoredSiteUrl().ok);
});
