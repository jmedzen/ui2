import test from 'node:test';
import assert from 'node:assert';
import { GET as getCourses } from '@/app/api/courses/route';
import { GET as getScan } from '@/app/api/scan/route';

test('API Courses & Scan Endpoints Suite', async (t) => {
  await t.test('/api/courses returns 684 courses and valid caching headers', async () => {
    const req = new Request('http://localhost:8410/api/courses');
    const res = await getCourses(req);

    assert.strictEqual(res.status, 200, 'Must return 200 OK');
    assert.ok(res.headers.get('ETag'), 'Must include ETag header');
    assert.ok(res.headers.get('Cache-Control')?.includes('must-revalidate'), 'Must include Cache-Control header');

    const data = await res.json();
    assert.ok(Array.isArray(data.courses), 'Must return courses array');
    assert.strictEqual(data.courses.length, 684, 'Must contain exactly 684 courses');
    assert.strictEqual(data.total_courses, 684, 'total_courses field must be 684');

    // Test 304 Not Modified conditional revalidation
    const etag = res.headers.get('ETag');
    const revalReq = new Request('http://localhost:8410/api/courses', {
      headers: { 'If-None-Match': etag! }
    });
    const revalRes = await getCourses(revalReq);
    assert.strictEqual(revalRes.status, 304, 'Must return 304 Not Modified when ETag matches');
  });

  await t.test('/api/scan returns scanner status and 20GB cache stats', async () => {
    const res = await getScan();
    assert.strictEqual(res.status, 200, 'Must return 200 OK');

    const data = await res.json();
    assert.strictEqual(data.status, 'active', 'Scanner status must be active');
    assert.strictEqual(typeof data.recentLogs, 'string', 'recentLogs must be string');
    assert.strictEqual(data.totalCourses, 684, 'Scanner totalCourses must be 684');

    assert.ok(data.cacheStats, 'Must return cacheStats object');
    assert.strictEqual(data.cacheStats.maxGb, 20, 'cacheStats.maxGb must be exactly 20');
    assert.strictEqual(data.cacheStats.maxBytes, 20 * 1024 * 1024 * 1024, 'cacheStats.maxBytes must be 20GB');
    assert.strictEqual(typeof data.cacheStats.currentBytes, 'number', 'currentBytes must be numeric');
    assert.strictEqual(typeof data.cacheStats.fileCount, 'number', 'fileCount must be numeric');
  });
});
