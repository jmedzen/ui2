import './helpers/isolated-media-cache';

import test from 'node:test';
import assert from 'node:assert';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalPdfPath } from '../src/lib/courseMedia';

// The media-key handling now lives in the PDF discovery hook.
const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'src', 'lib', 'usePdfTracks.ts'), 'utf8');

test('PDF discovery deduplicates one physical file', async (t) => {
  // Imported directly now that the helper lives in a plain module; it used to be
  // regex-extracted from CourseDetail.tsx and eval'd.
  const canonical = canonicalPdfPath;

  await t.test('treats a duplicated trailing segment as the same file', () => {
    // Regression: `bilu` was treated as a volume name AND as a media key, so the
    // same PDF was listed twice as ".../bilu/bilu/1.pdf" and ".../bilu/1.pdf".
    assert.strictEqual(
      canonical('/media/解經/解深密經/一切法相品第四-彌勒講堂/bilu/bilu', '1. 一切法相品-台中.pdf'),
      canonical('/media/解經/解深密經/一切法相品第四-彌勒講堂/bilu', '1. 一切法相品-台中.pdf')
    );
  });

  await t.test('keeps genuinely different files distinct', () => {
    const base = '/media/解經/解深密經/一切法相品第四-彌勒講堂/bilu';
    assert.notStrictEqual(
      canonical(base, '1. 一切法相品-台中.pdf'),
      canonical(base, '2. 一切法相品-台中.pdf')
    );
  });

  await t.test('keeps same-named files in different folders distinct', () => {
    assert.notStrictEqual(
      canonical('/media/courseA/bilu', 'notes.pdf'),
      canonical('/media/courseB/bilu', 'notes.pdf')
    );
  });

  await t.test('normalises percent-encoding and whitespace', () => {
    assert.strictEqual(
      canonical('/media/course%20A/bilu', '1.%20notes.pdf'),
      canonical('/media/course A/bilu', '1. notes.pdf')
    );
  });

  await t.test('collapses repeated separators and stray segments', () => {
    assert.strictEqual(
      canonical('//media///courseA//bilu//', 'notes.pdf'),
      canonical('/media/courseA/bilu', 'notes.pdf')
    );
  });
});

test('PDF discovery no longer treats media keys as volume names', () => {
  // The single-folder upstream shape is { video: [...], bilu: [...] }; `bilu`
  // must be handled by the media-key branch only.
  assert.match(source, /MEDIA_KEYS\s*=\s*\['bilu',\s*'pdf',\s*'beizhu'\]/);
  assert.match(source, /isMediaKeyObject/);
  // The PDF branch must derive volumes from the filtered list, never from every
  // top-level key (which is what produced `[bilu] ...` duplicates).
  assert.match(source, /sortVolumes\(volumeKeys\)/);
  assert.ok(
    !/sortVolumes\(Object\.keys\(listData\)\)[\s\S]{0,200}?MEDIA_KEYS/.test(source),
    'the PDF branch must not treat every top-level key as a volume'
  );
});
