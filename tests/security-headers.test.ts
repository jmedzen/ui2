import test from 'node:test';
import assert from 'node:assert';
import { NextRequest } from 'next/server';

import { proxy } from '@/proxy';

test('security proxy — HTML documents get CSP and clickjacking headers', () => {
  const response = proxy(new NextRequest('http://localhost:8410/'));

  const csp = response.headers.get('content-security-policy') || '';
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /form-action 'self'/);
  assert.match(csp, /media-src 'self' blob: https:\/\/www\.fayun\.org/);
  assert.match(csp, /connect-src [^;]*https:\/\/www\.fayun\.org/);
  assert.strictEqual(response.headers.get('x-frame-options'), 'DENY');
  assert.strictEqual(response.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(response.headers.get('permissions-policy'));
});

test('security proxy — plain-HTTP LAN mode does not upgrade assets to a dead TLS port', (t) => {
  const previous = process.env.ADMIN_ALLOW_INSECURE_HTTP;
  process.env.ADMIN_ALLOW_INSECURE_HTTP = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.ADMIN_ALLOW_INSECURE_HTTP;
    else process.env.ADMIN_ALLOW_INSECURE_HTTP = previous;
  });

  const response = proxy(new NextRequest('http://192.168.1.10:8410/'));
  const csp = response.headers.get('content-security-policy') || '';
  assert.doesNotMatch(csp, /upgrade-insecure-requests/);
  assert.match(csp, /frame-ancestors 'none'/, 'clickjacking protection still applies');
});

test('security proxy — proxied PDFs/media are not blocked by document framing rules', () => {
  for (const pathname of [
    '/api/proxy?path=%2Fmedia%2Fnotes.pdf',
    '/api/admin/session',
    '/_next/static/chunks/app.js',
    '/favicon.ico'
  ]) {
    const response = proxy(new NextRequest(`http://localhost:8410${pathname}`));
    assert.strictEqual(
      response.headers.get('content-security-policy'),
      null,
      `${pathname} must not receive document CSP`
    );
    assert.strictEqual(
      response.headers.get('x-frame-options'),
      null,
      `${pathname} must not receive X-Frame-Options`
    );
  }
});
