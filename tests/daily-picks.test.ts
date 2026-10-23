import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import {
  weightForCourse,
  dayIndexFor,
  dayLabelFor,
  dayLabelFromIndex,
  msUntilNextDay,
  pickDailyPicks,
  isRecommendable,
  describeCourse,
  iconForCourse,
  DAILY_PICK_COUNT,
  RECOMMENDATION_TIMEZONE_OFFSET_MINUTES
} from '../src/lib/dailyPicks';
import type { CourseItem } from '../src/types/course';

/** Builds a course with only the fields the picker reads. */
function course(id: number, overrides: Partial<CourseItem> = {}): CourseItem {
  return {
    id,
    name: `課程 ${id}`,
    main_menu: 'dharma',
    main_menu_title: '佛法經論',
    sub_menu: 'jing',
    sub_menu_title: '解經（經藏）',
    topic: 'topic',
    topic_title: `主題${id % 5}`,
    location: '法雲寺',
    time: '1998',
    total_episodes: 5,
    audio_path: `/media/${id}/audio`,
    video_path: null,
    lecture_path: null,
    poster_path: null,
    comment: null,
    pdfs: [],
    ...overrides
  };
}

/** A catalogue built the way the real one is not: fully distinct topics. */
function distinctCatalog(size: number): CourseItem[] {
  return Array.from({ length: size }, (_, i) =>
    course(i + 1, { topic_title: `主題${i + 1}`, name: `課程 ${i + 1}` })
  );
}

test('Daily picks rotation', async (t) => {
  await t.test('the day rolls over at UTC+8 midnight, not the host timezone', () => {
    // 2026-10-21 15:59:59 UTC === 2026-10-21 23:59:59 +08:00
    const beforeMidnight = Date.UTC(2026, 9, 21, 15, 59, 59);
    // 2026-10-21 16:00:00 UTC === 2026-10-22 00:00:00 +08:00
    const afterMidnight = Date.UTC(2026, 9, 21, 16, 0, 0);

    assert.strictEqual(
      dayIndexFor(afterMidnight) - dayIndexFor(beforeMidnight),
      1,
      'the day must advance exactly at +08:00 midnight'
    );
    assert.notStrictEqual(dayLabelFor(beforeMidnight), dayLabelFor(afterMidnight));
    assert.strictEqual(dayLabelFor(beforeMidnight), '2026-10-21');
    assert.strictEqual(dayLabelFor(afterMidnight), '2026-10-22');
    assert.strictEqual(RECOMMENDATION_TIMEZONE_OFFSET_MINUTES, 480);
  });

  await t.test('the day index is constant for 24 hours', () => {
    // Start exactly at 00:00 +08:00 (16:00 UTC the previous day) so every offset
    // below is measured from the real day boundary. Starting at 00:00 UTC would
    // already be 08:00 local, and +18h from there crosses midnight.
    const start = Date.UTC(2026, 9, 21, 16, 0, 0); // 2026-10-22 00:00 +08:00
    assert.strictEqual(dayLabelFor(start), '2026-10-22');

    const day = dayIndexFor(start);
    for (const hours of [1, 6, 12, 18, 23]) {
      assert.strictEqual(
        dayIndexFor(start + hours * 3_600_000),
        day,
        `day must not change after ${hours}h`
      );
    }
    // One millisecond before the next boundary is still the same day.
    assert.strictEqual(dayIndexFor(start + 24 * 3_600_000 - 1), day);
    assert.strictEqual(dayIndexFor(start + 24 * 3_600_000), day + 1);
  });

  await t.test('the midnight timer lands inside the next 24 hours', () => {
    for (const offsetHours of [0, 5, 11, 17, 23]) {
      const now = Date.UTC(2026, 9, 22, offsetHours, 30, 0);
      const delay = msUntilNextDay(now);
      assert.ok(delay > 0, 'delay must be positive');
      assert.ok(delay <= 86_400_000, 'delay must not exceed one day');
      // Waiting that long must cross exactly one day boundary.
      assert.strictEqual(dayIndexFor(now + delay) - dayIndexFor(now), 1);
    }
  });

  await t.test('labels round-trip through the day index', () => {
    const now = Date.UTC(2026, 0, 15, 4, 0, 0);
    assert.strictEqual(dayLabelFromIndex(dayIndexFor(now)), dayLabelFor(now));
  });
});

test('Daily picks selection', async (t) => {
  await t.test('returns exactly three courses', () => {
    const picks = pickDailyPicks(distinctCatalog(50), dayIndexFor(Date.UTC(2026, 9, 22)));
    assert.strictEqual(picks.length, DAILY_PICK_COUNT);
    assert.strictEqual(DAILY_PICK_COUNT, 3);
  });

  await t.test('is deterministic for the same day', () => {
    const catalog = distinctCatalog(60);
    const day = dayIndexFor(Date.UTC(2026, 9, 22));
    const a = pickDailyPicks(catalog, day).map((c) => c.id);
    const b = pickDailyPicks(catalog, day).map((c) => c.id);
    // The same day must render identically on the server and in the browser,
    // otherwise hydration differs.
    assert.deepStrictEqual(a, b);
  });

  await t.test('changes from one day to the next', () => {
    const catalog = distinctCatalog(60);
    const day = dayIndexFor(Date.UTC(2026, 9, 22));
    const today = pickDailyPicks(catalog, day).map((c) => c.id);
    const tomorrow = pickDailyPicks(catalog, day + 1).map((c) => c.id);
    assert.notDeepStrictEqual(today, tomorrow, 'the set must rotate daily');
  });

  await t.test('never repeats a course within one day', () => {
    const catalog = distinctCatalog(80);
    for (let day = 0; day < 40; day++) {
      const picks = pickDailyPicks(catalog, day);
      assert.strictEqual(new Set(picks.map((c) => c.id)).size, picks.length, `day ${day} repeated`);
    }
  });

  await t.test('spreads across different categories', () => {
    // A realistic catalogue: one huge category (法語珠璣 holds 197 of 684 rows)
    // and many small ones. A pure top-3-by-hash would often return three from
    // the same bucket.
    const catalog = [
      ...Array.from({ length: 200 }, (_, i) =>
        course(i + 1, { topic_title: '法語珠璣', name: `法語 ${i + 1}` })
      ),
      ...Array.from({ length: 40 }, (_, i) =>
        course(1000 + i, { topic_title: `專題${i}`, name: `專題課 ${i}` })
      )
    ];

    for (let day = 0; day < 30; day++) {
      const picks = pickDailyPicks(catalog, day);
      const topics = new Set(picks.map((c) => c.topic_title));
      assert.strictEqual(
        topics.size,
        picks.length,
        `day ${day} returned duplicate categories: ${picks.map((c) => c.topic_title).join(',')}`
      );
    }
  });

  await t.test('skips courses with no media at all', () => {
    const catalog = [
      course(1, { audio_path: null, video_path: null, pdfs: [] }),
      course(2),
      course(3),
      course(4)
    ];
    for (let day = 0; day < 20; day++) {
      const ids = pickDailyPicks(catalog, day).map((c) => c.id);
      assert.ok(!ids.includes(1), `day ${day} recommended the empty course`);
    }
  });

  await t.test('accepts a course that only has a PDF', () => {
    assert.ok(isRecommendable(course(9, { audio_path: null, pdfs: [{ filename: 'a.pdf', url: 'u' }] })));
    assert.ok(isRecommendable(course(9, { audio_path: null, video_path: '/v' })));
    assert.ok(!isRecommendable(course(9, { audio_path: null, video_path: null, pdfs: [] })));
    assert.ok(!isRecommendable(course(9, { name: '   ', audio_path: '/a' })));
  });

  await t.test('tolerates short and malformed catalogues', () => {
    assert.deepStrictEqual(pickDailyPicks([], 5), []);
    assert.strictEqual(pickDailyPicks([course(1)], 5).length, 1);
    // Fewer distinct topics than requested still fills all three slots.
    const oneTopic = Array.from({ length: 10 }, (_, i) => course(i + 1, { topic_title: '同一主題' }));
    assert.strictEqual(pickDailyPicks(oneTopic, 5).length, 3);
  });

  await t.test('result does not depend on catalog order', () => {
    const catalog = distinctCatalog(40);
    const reversed = [...catalog].reverse();
    const day = dayIndexFor(Date.UTC(2026, 9, 22));
    assert.deepStrictEqual(
      pickDailyPicks(catalog, day).map((c) => c.id),
      pickDailyPicks(reversed, day).map((c) => c.id)
    );
  });
});

test('Daily picks against the real catalogue', async (t) => {
  const dbPath = fs.existsSync(path.join(process.cwd(), 'data', 'courses_db.json'))
    ? path.join(process.cwd(), 'data', 'courses_db.json')
    : path.join(process.cwd(), 'src', 'data', 'courses_db.json');
  const courses: CourseItem[] = JSON.parse(fs.readFileSync(dbPath, 'utf-8')).courses;
  const today = dayIndexFor(Date.UTC(2026, 9, 22, 4, 0, 0));

  await t.test('always returns three real, openable courses', () => {
    for (let d = today; d < today + 60; d++) {
      const picks = pickDailyPicks(courses, d);
      assert.strictEqual(picks.length, 3, `day ${d} did not return three`);
      for (const c of picks) {
        assert.ok(isRecommendable(c), `unopenable course ${c.id} recommended`);
        assert.ok(c.name.trim().length > 0);
      }
    }
  });

  await t.test('never repeats a flagship course shown on the same page', () => {
    // 瑜伽師地論 id=97 is the fixed hero card; recommending it again below would
    // show the same 478-episode course twice on one screen.
    const excludeIds = [97, 3, 91, 31, 465, 8];
    for (let d = today; d < today + 120; d++) {
      const ids = pickDailyPicks(courses, d, 3, { excludeIds }).map((c) => c.id);
      for (const excluded of excludeIds) {
        assert.ok(!ids.includes(excluded), `day ${d} repeated flagship ${excluded}`);
      }
    }
  });

  await t.test('weights favour substantial courses without hiding short ones', () => {
    // A 478-episode course must outrank a 1-episode clip...
    const huge = courses.find((c) => c.id === 97)!;
    const clip = courses.find((c) => (c.total_episodes || 0) === 1)!;
    assert.ok(weightForCourse(huge) > weightForCourse(clip));

    // ...but the curve must stay gentle, or the section becomes a rotation of
    // the same few blockbusters.
    const ratio = weightForCourse(huge) / weightForCourse(clip);
    assert.ok(ratio > 2, `weight ratio too flat: ${ratio}`);
    assert.ok(ratio < 50, `weight ratio too aggressive: ${ratio}`);

    // Over a year, single-episode clips should still get slots — just fewer.
    const counts = new Map<number, number>();
    for (let d = today; d < today + 365; d++) {
      for (const c of pickDailyPicks(courses, d)) counts.set(c.id, (counts.get(c.id) || 0) + 1);
    }
    const byId = new Map(courses.map((c) => [c.id, c]));
    let clipSlots = 0;
    let allSlots = 0;
    for (const [id, n] of counts) {
      allSlots += n;
      if ((byId.get(id)?.total_episodes || 0) <= 1) clipSlots += n;
    }
    const share = clipSlots / allSlots;
    assert.ok(share > 0.2, `short clips nearly excluded (${(share * 100).toFixed(1)}%)`);
    assert.ok(share < 0.6, `short clips dominate (${(share * 100).toFixed(1)}%)`);
  });

  await t.test('a full year surfaces most of the catalogue', () => {
    const seen = new Set<number>();
    for (let d = today; d < today + 365; d++) {
      for (const c of pickDailyPicks(courses, d)) seen.add(c.id);
    }
    // With three slots a day the theoretical maximum is ~1095 draws; reaching
    // most of the 681 recommendable courses means the rotation is not stuck.
    assert.ok(seen.size > 400, `only ${seen.size} distinct courses in a year`);
  });
});

test('Daily pick card content', async (t) => {
  await t.test('describes a course from its media it actually has', () => {
    // The catalog stores comments for only 21 of 684 rows, so the fallback is
    // the normal path and must not be blank.
    const noComment = course(4, { comment: null, total_episodes: 12, video_path: '/v' });
    const text = describeCourse(noComment);
    assert.match(text, /12 講/);
    assert.match(text, /影音/);

    const withComment = course(5, { comment: '五識身相應地一 意地第二之一' });
    assert.strictEqual(describeCourse(withComment), '五識身相應地一 意地第二之一');
  });

  await t.test('truncates a very long comment instead of breaking the card', () => {
    const long = course(6, { comment: '法'.repeat(200) });
    const text = describeCourse(long);
    assert.ok(text.length <= 61, `expected <= 61 chars, got ${text.length}`);
    assert.ok(text.endsWith('…'));
  });

  await t.test('gives a course a stable icon', () => {
    const c = course(42);
    assert.strictEqual(iconForCourse(c), iconForCourse(c));
    assert.ok(iconForCourse(c).length > 0);
  });
});

test('Daily picks are wired into the home page', async (t) => {
  const home = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'HomePortal.tsx'), 'utf-8');

  await t.test('the section sits between the divisions and the core recommendations', () => {
    const divisions = home.indexOf('主要學習法種類');
    const daily = home.indexOf('今日隨機推薦');
    const featured = home.indexOf('核心經典講記推薦');
    assert.ok(divisions > 0 && daily > 0 && featured > 0, 'all three sections must exist');
    assert.ok(divisions < daily, 'daily picks must come after the study categories');
    assert.ok(daily < featured, 'daily picks must come before the core recommendations');
  });

  await t.test('the section is not rendered before hydration', () => {
    // Rendering it during SSR would use the server's date and mismatch the
    // browser's, so it is gated on a hydration flag and a non-empty list.
    assert.match(home, /\{hasCatalog && dailyPicks\.length > 0 && \(/);
    assert.match(home, /const isHydrated = useIsHydrated\(\);/);
  });

  await t.test('cards reuse the featured card layout', () => {
    assert.match(home, /className="featured-course-card daily-pick-card"/);
  });
});
