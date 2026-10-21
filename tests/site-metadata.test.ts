import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import manifest from '@/app/manifest';
import { DEFAULT_SITE_URL, SITE_NAME, absoluteUrl, siteUrl } from '@/lib/site';

/**
 * `layout.tsx` imports globals.css, which the test runner cannot parse, so the
 * metadata contract is asserted against the built HTML by
 * `tests/verify-social-metadata.ts` and against the source here.
 */
const LAYOUT_SRC = fs.readFileSync(
  path.join(process.cwd(), 'src', 'app', 'layout.tsx'),
  'utf-8'
);

/**
 * Social link previews and installability.
 *
 * These are generated entirely from metadata, never from the page body, so a
 * rename that only touched the visible header left every share card still
 * advertising the upstream archive's name. The same gap meant there were no og:
 * or twitter: tags at all, and no PWA manifest, so a shared link fell back to
 * scraping the description and the site could not be installed.
 */

const PUBLIC = path.join(process.cwd(), 'public');

test('site identity — the canonical origin is ui2.mahabodhi.co', (t) => {
  const saved = process.env.SITE_URL;
  t.after(() => {
    if (saved === undefined) delete process.env.SITE_URL;
    else process.env.SITE_URL = saved;
  });

  delete process.env.SITE_URL;
  assert.strictEqual(siteUrl(), DEFAULT_SITE_URL);
  assert.strictEqual(DEFAULT_SITE_URL, 'https://ui2.mahabodhi.co');

  // A bare host is accepted, and a trailing slash or path is normalised away so
  // og:url never gains a double slash.
  process.env.SITE_URL = 'example.test';
  assert.strictEqual(siteUrl(), 'https://example.test');
  process.env.SITE_URL = 'https://example.test/';
  assert.strictEqual(siteUrl(), 'https://example.test');
  process.env.SITE_URL = 'https://example.test/some/path';
  assert.strictEqual(siteUrl(), 'https://example.test');
  process.env.SITE_URL = '   ';
  assert.strictEqual(siteUrl(), DEFAULT_SITE_URL, 'a blank value must fall back');

  assert.strictEqual(absoluteUrl('/'), `${DEFAULT_SITE_URL}/`);
  assert.strictEqual(absoluteUrl('/courses'), `${DEFAULT_SITE_URL}/courses`);
});

test('site identity — share previews name 妙境法軒, not the upstream archive', () => {
  // These fields are what a platform reads; it never looks at the page body, so
  // renaming only the visible header left every share card unchanged.
  assert.match(LAYOUT_SRC, /openGraph:\s*\{/, 'openGraph metadata must exist');
  assert.match(LAYOUT_SRC, /siteName:\s*SITE_NAME/, 'og:site_name must come from the shared identity');
  assert.match(LAYOUT_SRC, /twitter:\s*\{/, 'twitter metadata must exist');
  assert.match(LAYOUT_SRC, /card:\s*'summary_large_image'/);
  assert.match(LAYOUT_SRC, /url:\s*'\/og-image\.png'/, 'the share image must be declared');
  assert.match(LAYOUT_SRC, /width:\s*1200/);
  assert.match(LAYOUT_SRC, /height:\s*630/, 'a 1.91:1 card avoids letterboxing');
  assert.match(LAYOUT_SRC, /metadataBase:\s*new URL\(siteUrl\(\)\)/,
    'without metadataBase the image URL is emitted relative and platforms cannot resolve it');

  assert.strictEqual(SITE_NAME, '妙境法軒');
  // The old name may survive only as a rights/attribution statement.
  assert.ok(
    LAYOUT_SRC.includes('法雲資訊網') ? /copyright[\s\S]{0,400}法雲資訊網/.test(LAYOUT_SRC) : true,
    'the upstream name may only appear inside the copyright attribution'
  );
});

test('site identity — canonical and icon declarations are present', () => {
  assert.match(LAYOUT_SRC, /canonical:\s*'\/'/, 'a canonical URL prevents duplicate-content previews');
  assert.match(LAYOUT_SRC, /apple-touch-icon\.png/);
  assert.match(LAYOUT_SRC, /icon-512\.png|icon-192\.png/);
  assert.match(LAYOUT_SRC, /themeColor:\s*'#f7f2e8'/, 'the install banner uses the themed colour');
});

test('PWA — manifest declares installable icons that actually exist', () => {
  const m = manifest();
  assert.strictEqual(m.short_name, SITE_NAME);
  assert.strictEqual(m.start_url, '/');
  assert.strictEqual(m.scope, '/');
  assert.strictEqual(m.display, 'standalone');
  assert.strictEqual(m.lang, 'zh-TW');

  const icons = m.icons || [];
  // Chrome refuses to install without a 192 and a 512.
  for (const required of ['192x192', '512x512']) {
    assert.ok(
      icons.some((icon) => icon.sizes === required),
      `manifest needs a ${required} icon to be installable`
    );
  }
  // Android crops maskable icons to a circle/rounded square.
  assert.ok(
    icons.some((icon) => icon.purpose === 'maskable'),
    'a maskable icon is required so the launcher does not letterbox the mark'
  );

  for (const icon of icons) {
    assert.match(String(icon.type), /^image\/png$/, 'PNG only: iOS cannot decode SVG icons');
    // Relative to scope, so the same build works on any host.
    assert.ok(String(icon.src).startsWith('/'), 'icon src must be root-relative');
    const file = path.join(PUBLIC, String(icon.src).replace(/^\//, ''));
    assert.ok(fs.existsSync(file), `declared icon is missing from public/: ${icon.src}`);
  }
});

test('PWA — every declared raster asset is a real image of the stated size', () => {
  // Guards against a placeholder or a mis-sized export being shipped: the
  // declared sizes are what the OS trusts when choosing a home-screen icon.
  const expected: Array<[string, number, number]> = [
    ['icon-32.png', 32, 32],
    ['favicon-48.png', 48, 48],
    ['apple-touch-icon.png', 180, 180],
    ['icon-192.png', 192, 192],
    ['icon-512.png', 512, 512],
    ['og-image.png', 1200, 630]
  ];

  for (const [name, width, height] of expected) {
    const file = path.join(PUBLIC, name);
    assert.ok(fs.existsSync(file), `${name} must exist`);
    const bytes = fs.readFileSync(file);
    // PNG signature + IHDR width/height at fixed offsets.
    assert.deepStrictEqual(
      [...bytes.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      `${name} must actually be a PNG`
    );
    assert.strictEqual(bytes.readUInt32BE(16), width, `${name} width`);
    assert.strictEqual(bytes.readUInt32BE(20), height, `${name} height`);
  }

  // The framework's default favicon ships a Vercel triangle; a branded build
  // must not still be carrying it.
  const ico = fs.readFileSync(path.join(process.cwd(), 'src', 'app', 'favicon.ico'));
  assert.ok(ico.length > 1000, 'favicon.ico must be a real multi-size icon');
});
