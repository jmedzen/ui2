/**
 * Whether the browser can show a multi-page PDF inside an <iframe>.
 *
 * iOS and iPadOS WebKit (every browser on those systems, Chrome included) render
 * only the FIRST page of a PDF placed in an iframe/embed, and the frame cannot be
 * scrolled to the rest. Opening the same URL as a top-level page uses the system
 * viewer and shows every page, so on those devices the viewer offers that instead.
 *
 * iPadOS 13+ reports itself as "Macintosh" (desktop Safari), so the user agent
 * alone is not enough: a "Mac" that has a touch screen is an iPad.
 */
export interface PdfEnvironment {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
}

export function canInlinePdf(env: PdfEnvironment): boolean {
  const ua = env.userAgent || '';
  if (/iPad|iPhone|iPod/i.test(ua)) return false;
  if ((env.platform === 'MacIntel' || /Macintosh/.test(ua)) && (env.maxTouchPoints ?? 0) > 1) {
    return false;
  }
  return true;
}
