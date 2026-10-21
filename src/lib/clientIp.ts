/**
 * Best-effort client identifier used for rate-limit buckets and audit records.
 *
 * `X-Forwarded-For` is client-controlled unless a reverse proxy overwrites it.
 * Trust is therefore opt-in and explicit: set TRUST_PROXY=1 only when every
 * path into this process passes through a proxy that rewrites the header. The
 * default deliberately buckets every caller together, which is conservative
 * (a shared budget) but cannot be escaped by inventing a new address per
 * request.
 */
export function isTrustedProxy(): boolean {
  const value = (process.env.TRUST_PROXY || '').trim().toLowerCase();
  return value === '1' || value === 'true';
}

function firstForwardedValue(request: Request, name: string): string {
  const raw = request.headers.get(name);
  if (!raw) return '';
  return raw.split(',')[0]?.trim() || '';
}

/**
 * Returns a stable bucket key for this request.
 *
 * This is a rate-limit/audit key, never an authorization decision.
 */
export function clientKeyFor(request: Request): string {
  if (isTrustedProxy()) {
    const forwarded = firstForwardedValue(request, 'x-forwarded-for');
    if (forwarded) return forwarded;
  }
  return 'local';
}
