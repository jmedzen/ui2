import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

test('Database Integrity Suite - courses_db.json validation', async (t) => {
  const dataDbPath = path.join(process.cwd(), 'data', 'courses_db.json');
  const srcDbPath = path.join(process.cwd(), 'src', 'data', 'courses_db.json');

  const dataDir = path.dirname(dataDbPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(dataDbPath) && fs.existsSync(srcDbPath)) {
    fs.copyFileSync(srcDbPath, dataDbPath);
  }

  await t.test('database files exist and are valid JSON', () => {
    assert.ok(fs.existsSync(dataDbPath), 'data/courses_db.json must exist');
    assert.ok(fs.existsSync(srcDbPath), 'src/data/courses_db.json must exist');

    const dataDb = JSON.parse(fs.readFileSync(dataDbPath, 'utf-8'));
    const srcDb = JSON.parse(fs.readFileSync(srcDbPath, 'utf-8'));

    assert.ok(Array.isArray(dataDb.courses), 'dataDb.courses must be an array');
    assert.ok(Array.isArray(srcDb.courses), 'srcDb.courses must be an array');
    assert.strictEqual(dataDb.courses.length, 684, 'Total courses in data/courses_db.json must be 684');
    assert.strictEqual(srcDb.courses.length, 684, 'Total courses in src/data/courses_db.json must be 684');
  });

  await t.test('all 684 courses have valid IDs, names, and menu hierarchies', () => {
    const db = JSON.parse(fs.readFileSync(srcDbPath, 'utf-8'));
    const idSet = new Set<number>();

    for (const course of db.courses) {
      assert.ok(typeof course.id === 'number' && course.id > 0, `Course ID must be positive number: ${course.id}`);
      assert.ok(!idSet.has(course.id), `Duplicate course ID detected: ${course.id}`);
      idSet.add(course.id);

      assert.ok(typeof course.name === 'string' && course.name.trim().length > 0, `Course name must not be empty (id=${course.id})`);
      assert.ok(typeof course.main_menu_title === 'string' && course.main_menu_title.length > 0, `Missing main_menu_title (id=${course.id})`);
      assert.ok(typeof course.sub_menu_title === 'string' && course.sub_menu_title.length > 0, `Missing sub_menu_title (id=${course.id})`);
    }

    assert.strictEqual(idSet.size, 684, 'Unique course count must be exactly 684');
  });

  await t.test('video courses count and path formatting', () => {
    const db = JSON.parse(fs.readFileSync(srcDbPath, 'utf-8'));
    const videoCourses = db.courses.filter((c: any) => c.video_path && c.video_path.trim() !== '');

    assert.strictEqual(videoCourses.length, 478, 'Must have exactly 478 courses with video_path');

    for (const course of videoCourses) {
      assert.ok(
        course.video_path.startsWith('/ftpadmin/') || course.video_path.startsWith('/'),
        `Video path must start with / (id=${course.id}): ${course.video_path}`
      );
      assert.ok(!course.video_path.includes('..'), `Video path must not contain traversal: ${course.video_path}`);
    }
  });

  await t.test('pdf documents formatting and validity', () => {
    const db = JSON.parse(fs.readFileSync(srcDbPath, 'utf-8'));
    const pdfCourses = db.courses.filter((c: any) => Array.isArray(c.pdfs) && c.pdfs.length > 0);

    assert.ok(pdfCourses.length > 0, 'There should be courses with PDF documents');

    let totalPdfCount = 0;
    for (const course of pdfCourses) {
      for (const pdf of course.pdfs) {
        totalPdfCount++;
        assert.ok(typeof pdf.filename === 'string' && pdf.filename.toLowerCase().endsWith('.pdf'), `PDF filename must end with .pdf: ${pdf.filename}`);
        assert.ok(typeof pdf.url === 'string' && pdf.url.startsWith('https://www.fayun.org'), `PDF URL must point to fayun.org: ${pdf.url}`);
      }
    }

    assert.ok(totalPdfCount >= 400, `Should have at least 400 total PDFs in catalog, found: ${totalPdfCount}`);
  });
});
