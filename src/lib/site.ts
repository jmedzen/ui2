/**
 * Canonical site identity, shared by the document metadata and the PWA
 * manifest.
 *
 * Every social platform needs an absolute og:url / og:image. Deriving it from
 * the request is not possible in the static `metadata` export, and hardcoding a
 * host breaks local development (previews would point at production). So the
 * deployment origin comes from `SITE_URL`, with a stable production default.
 */

/** Production origin. Override with SITE_URL for previews or a new domain. */
export const DEFAULT_SITE_URL = 'https://ui2.mahabodhi.co';

export const SITE_NAME = '妙境法軒';

/** Subtitle used in the header, the share card and the manifest description. */
export const SITE_SUBTITLE = '玅境長老經典講記講述';

export const SITE_DESCRIPTION =
  '玅境長老經典講記典藏平台：完整收錄 fayun.org 之佛法經論、禪修止觀、戒律與專題開示，' +
  '提供 MP3 音訊、影音講記與 PDF 講義的線上研讀。';

/**
 * Absolute origin with no trailing slash.
 *
 * Falls back to the production default when unset or blank, and tolerates an
 * operator pasting a URL with a trailing slash or a path.
 */
export function siteUrl(): string {
  const raw = (process.env.SITE_URL || '').trim();
  if (!raw) return DEFAULT_SITE_URL;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return DEFAULT_SITE_URL;
  }
}

/** Absolute URL for a path on the canonical origin. */
export function absoluteUrl(pathname: string): string {
  const base = siteUrl();
  if (!pathname || pathname === '/') return `${base}/`;
  return `${base}${pathname.startsWith('/') ? '' : '/'}${pathname}`;
}
