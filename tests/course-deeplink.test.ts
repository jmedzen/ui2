import test from 'node:test';
import assert from 'node:assert';

import {
  buildCoursePath,
  parseCatalogPath,
  HOME_PATH
} from '../src/lib/catalogUrl';
import { parseCourseId, getCourseById, getCourses } from '../src/lib/catalog';

test('Course deep links', async (t) => {
  await t.test('format and parse round-trip', () => {
    for (const [id, ep] of [
      [97, null],
      [97, 12],
      [1, 1],
      [684, 999]
    ] as const) {
      const path = buildCoursePath(id, ep);
      const parsed = parseCatalogPath(path);
      assert.strictEqual(parsed.courseId, id, `course id should survive: ${path}`);
      assert.strictEqual(parsed.episode, ep, `episode should survive: ${path}`);
    }
  });

  await t.test('home is the empty selection', () => {
    assert.strictEqual(buildCoursePath(null), HOME_PATH);
    assert.deepStrictEqual(parseCatalogPath('/'), { courseId: null, episode: null });
  });

  await t.test('invalid ids fall back to home instead of a broken URL', () => {
    assert.strictEqual(buildCoursePath(0), HOME_PATH);
    assert.strictEqual(buildCoursePath(-3), HOME_PATH);
    assert.strictEqual(buildCoursePath(Number.NaN), HOME_PATH);
    // An invalid episode degrades to the course, never to a 404 path.
    assert.strictEqual(buildCoursePath(97, 0), '/course/97');
    assert.strictEqual(buildCoursePath(97, Number.NaN), '/course/97');
  });

  await t.test('the ?ep= query form is accepted and wins over the segment', () => {
    // Older share links used `?ep=`; they must still resolve.
    assert.deepStrictEqual(parseCatalogPath('/course/97', '?ep=5'), {
      courseId: 97,
      episode: 5
    });
    assert.deepStrictEqual(parseCatalogPath('/course/97/ep/2', '?ep=5'), {
      courseId: 97,
      episode: 5
    });
    // A non-numeric query value must not poison a valid segment.
    assert.deepStrictEqual(parseCatalogPath('/course/97/ep/2', '?ep=abc'), {
      courseId: 97,
      episode: 2
    });
  });

  await t.test('unrelated paths do not select anything', () => {
    for (const path of ['/', '/about', '/courses', '/course', '/course/abc', '/api/courses']) {
      assert.strictEqual(parseCatalogPath(path).courseId, null, `${path} must not select`);
    }
  });

  await t.test('trailing slashes and fragments are tolerated', () => {
    assert.deepStrictEqual(parseCatalogPath('/course/97/'), { courseId: 97, episode: null });
    assert.deepStrictEqual(parseCatalogPath('/course/97/ep/3/'), { courseId: 97, episode: 3 });
    assert.deepStrictEqual(parseCatalogPath('/course/97#top'), { courseId: 97, episode: null });
  });

  await t.test('parseCourseId rejects partially numeric params', () => {
    assert.strictEqual(parseCourseId('97'), 97);
    assert.strictEqual(parseCourseId('0'), 0);
    // `parseInt('12abc')` would return 12, silently serving the wrong course.
    assert.strictEqual(parseCourseId('12abc'), null);
    assert.strictEqual(parseCourseId('12.5'), null);
    assert.strictEqual(parseCourseId(''), null);
    assert.strictEqual(parseCourseId(undefined), null);
    assert.strictEqual(parseCourseId('-5'), null);
    assert.strictEqual(parseCourseId('1234567890'), null);
  });

  await t.test('the catalog resolves a course by id', () => {
    const courses = getCourses();
    assert.ok(courses.length > 0, 'catalog must load from data/ or src/data/');
    const first = courses[0];
    const found = getCourseById(first.id);
    assert.ok(found, `course ${first.id} must be found`);
    assert.strictEqual(found!.name, first.name);
    assert.strictEqual(getCourseById(-1), null);
    assert.strictEqual(getCourseById(Number.NaN), null);
  });
});
