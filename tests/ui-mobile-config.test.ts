import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

test('UI, Mobile Configuration & Theme Integrity Suite', async (t) => {
  await t.test('layout.tsx has explicit head with viewport meta tag for mobile Firefox', () => {
    const layoutPath = path.join(process.cwd(), 'src', 'app', 'layout.tsx');
    const content = fs.readFileSync(layoutPath, 'utf-8');

    assert.ok(content.includes('<meta name="viewport"'), 'layout.tsx must contain explicit <meta name="viewport" tag');
    assert.ok(content.includes('width=device-width'), 'viewport must declare width=device-width');
    assert.ok(content.includes('viewport-fit=cover'), 'viewport must declare viewport-fit=cover');
    assert.ok(content.includes('<head>'), 'layout.tsx must have an explicit <head> element');
  });

  await t.test('globals.css defines Zen Modern serif fonts and all 6 themes', () => {
    const cssPath = path.join(process.cwd(), 'src', 'app', 'globals.css');
    const css = fs.readFileSync(cssPath, 'utf-8');

    assert.ok(css.includes('--font-serif'), 'Must define --font-serif for classical Chinese texts');
    assert.ok(css.includes('Noto Serif TC') || css.includes('Songti TC'), 'Must include classical serif font fallbacks');

    const themes = ['dark', 'light', 'pine', 'sandalwood', 'zen', 'gruvbox'];
    for (const theme of themes) {
      assert.ok(css.includes(`[data-theme='${theme}']`) || css.includes(`.app-root.${theme}`), `Theme styling for ${theme} must exist`);
    }
  });

  await t.test('globals.css defines mobile overrides and 960px breakpoint', () => {
    const cssPath = path.join(process.cwd(), 'src', 'app', 'globals.css');
    const css = fs.readFileSync(cssPath, 'utf-8');

    assert.ok(css.includes('@media (max-width: 960px)'), 'Must define 960px mobile media query');
    assert.ok(css.includes('.app-root.is-mobile-screen'), 'Must define .is-mobile-screen class overrides for mobile Firefox');
    assert.ok(css.includes('will-change: transform'), 'Sidebar drawer must use will-change: transform for hardware acceleration');
  });

  await t.test('globals.css defines Zen focus mode and split resizer', () => {
    const cssPath = path.join(process.cwd(), 'src', 'app', 'globals.css');
    const css = fs.readFileSync(cssPath, 'utf-8');

    assert.ok(css.includes('.layout-wrapper.zen-focus-mode'), 'Must define Zen focus mode CSS rules');
    assert.ok(css.includes('.split-resizer'), 'Must define .split-resizer CSS rules');
    assert.ok(css.includes('.split-resizer-knob'), 'Must define .split-resizer-knob CSS rules');
  });

  await t.test('Docker configuration enforces 20GB media cache limit', () => {
    const composePath = path.join(process.cwd(), 'compose.yaml');
    const composeContent = fs.readFileSync(composePath, 'utf-8');
    assert.ok(composeContent.includes('MEDIA_CACHE_MAX_BYTES=21474836480'), 'compose.yaml must specify 20GB (21474836480 bytes)');

    const dockerfilePath = path.join(process.cwd(), 'Dockerfile');
    const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf-8');
    assert.ok(dockerfileContent.includes('ENV MEDIA_CACHE_MAX_BYTES=21474836480'), 'Dockerfile must specify 20GB limit');
  });
});
