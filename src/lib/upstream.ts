/**
 * The single gate every server-side request to the media origin goes through.
 *
 * Two problems lived here before this module existed:
 *
 *  - Redirects were followed blindly. `fetch()` defaults to `redirect: 'follow'`,
 *    and the host allowlist was only checked against the FIRST URL. Any redirect
 *    the origin issued — an open redirect, a misconfigured vhost, a downgrade to
 *    `http://` — was followed to wherever it pointed, and the body was streamed
 *    back to the caller (and persisted into the media cache) as if it came from
 *    fayun.org. Every hop is now re-validated against the same policy.
 *
 *  - There was no timeout at all. A stalled origin held the request forever. In
 *    the background cache that was fatal: three wedged transfers held all three
 *    download slots permanently, the 200-entry queue filled behind them, and
 *    caching stopped until the process restarted. Two bounds now apply: one for
 *    the response headers, and an idle bound that only runs while a read is
 *    actually waiting on the network (so a paused media element applying
 *    backpressure is never mistaken for a dead origin).
 */

export const ALLOWED_UPSTREAM_HOSTS = ['www.fayun.org', 'fayun.org'];

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
const DEFAULT_HEADER_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_REDIRECTS = 5;

function positiveEnvInt(name: string, fallback: number): number {
  const parsed = Number.parseInt((process.env[name] || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Time allowed for the origin to start answering (read per call, so tests can set it). */
export function upstreamHeaderTimeoutMs(): number {
  return positiveEnvInt('UPSTREAM_TIMEOUT_MS', DEFAULT_HEADER_TIMEOUT_MS);
}

/** Time allowed between two body chunks while a read is pending. */
export function upstreamIdleTimeoutMs(): number {
  return positiveEnvInt('UPSTREAM_IDLE_TIMEOUT_MS', DEFAULT_IDLE_TIMEOUT_MS);
}

export type UpstreamRejectReason = 'invalid' | 'protocol' | 'userinfo' | 'host' | 'port';

export type UpstreamCheck =
  | { ok: true; url: URL }
  | { ok: false; reason: UpstreamRejectReason };

/**
 * Validates one upstream URL: HTTPS only, allowlisted host, default port, no
 * userinfo. `base` resolves relative `Location` headers against the hop that
 * issued them.
 */
export function checkUpstreamUrl(input: string | URL, base?: string | URL): UpstreamCheck {
  let url: URL;
  try {
    url = base === undefined ? new URL(input) : new URL(input, base);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'protocol' };
  if (url.username || url.password) return { ok: false, reason: 'userinfo' };
  if (!ALLOWED_UPSTREAM_HOSTS.includes(url.hostname.toLowerCase())) {
    return { ok: false, reason: 'host' };
  }
  if ((url.port || '443') !== '443') return { ok: false, reason: 'port' };
  return { ok: true, url };
}

/** The origin redirected somewhere the policy does not allow. */
export class UpstreamPolicyError extends Error {
  constructor(message: string, readonly location?: string) {
    super(message);
    this.name = 'UpstreamPolicyError';
  }
}

/** The origin did not answer (headers) or stopped sending (idle) in time. */
export class UpstreamTimeoutError extends Error {
  constructor(readonly phase: 'headers' | 'idle') {
    super(`upstream ${phase} timeout`);
    this.name = 'UpstreamTimeoutError';
  }
}

export interface UpstreamFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  maxRedirects?: number;
}

/**
 * Wraps the body so a read that waits longer than `idleMs` aborts the transfer.
 *
 * The timer only runs inside `pull`, i.e. while the consumer has asked for data
 * and the network has not delivered it. Cancelling the wrapper (a client that
 * disconnects) aborts the upstream request instead of leaving it to drain.
 */
function withIdleGuard(res: Response, controller: AbortController, idleMs: number): Response {
  if (!res.body || NULL_BODY_STATUSES.has(res.status)) return res;
  const reader = res.body.getReader();

  const guarded = new ReadableStream<Uint8Array>({
    async pull(streamController) {
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        idleTimer = setTimeout(() => {
          controller.abort();
          reject(new UpstreamTimeoutError('idle'));
        }, idleMs);
      });
      try {
        const { done, value } = await Promise.race([reader.read(), idle]);
        if (done) streamController.close();
        else if (value) streamController.enqueue(value);
      } catch (error) {
        reader.cancel().catch(() => {});
        streamController.error(error);
      } finally {
        clearTimeout(idleTimer);
      }
    },
    cancel(reason) {
      controller.abort();
      return reader.cancel(reason).catch(() => {});
    }
  });

  return new Response(guarded, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers
  });
}

/**
 * `fetch` for the media origin with per-hop validation and timeouts.
 *
 * Throws `UpstreamPolicyError` for a rejected target or redirect and
 * `UpstreamTimeoutError` when the headers do not arrive in time. Body stalls
 * surface as an `UpstreamTimeoutError('idle')` from the returned stream.
 */
export async function fetchUpstream(
  target: string,
  options: UpstreamFetchOptions = {}
): Promise<Response> {
  const first = checkUpstreamUrl(target);
  if (!first.ok) throw new UpstreamPolicyError(`upstream target rejected (${first.reason})`);

  const headerTimeoutMs = options.timeoutMs ?? upstreamHeaderTimeoutMs();
  const idleTimeoutMs = options.idleTimeoutMs ?? upstreamIdleTimeoutMs();
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  const controller = new AbortController();
  let headersTimedOut = false;
  const headerTimer = setTimeout(() => {
    headersTimedOut = true;
    controller.abort();
  }, headerTimeoutMs);

  let url = first.url;
  let method = (options.method || 'GET').toUpperCase();
  let body = options.body;

  try {
    for (let hop = 0; ; hop++) {
      let res: Response;
      try {
        res = await fetch(url.href, {
          method,
          headers: options.headers,
          body,
          cache: 'no-store',
          redirect: 'manual',
          signal: controller.signal
        });
      } catch (error) {
        if (headersTimedOut) throw new UpstreamTimeoutError('headers');
        throw error;
      }

      if (!REDIRECT_STATUSES.has(res.status)) {
        clearTimeout(headerTimer);
        return withIdleGuard(res, controller, idleTimeoutMs);
      }

      // A redirect body is never used; release the socket before the next hop.
      await res.body?.cancel().catch(() => {});

      const location = res.headers.get('location');
      if (!location) throw new UpstreamPolicyError('upstream redirect without a Location header');
      if (hop >= maxRedirects) throw new UpstreamPolicyError('too many upstream redirects', location);

      const next = checkUpstreamUrl(location, url);
      if (!next.ok) {
        throw new UpstreamPolicyError(`upstream redirect rejected (${next.reason})`, location);
      }

      // Standard method rewriting: 303 always, and 301/302 for POST, become GET.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      url = next.url;
    }
  } finally {
    clearTimeout(headerTimer);
  }
}
