/**
 * Runtime-editable site settings.
 *
 * The canonical origin used to live only in `SITE_URL` and a build-time
 * constant, so changing the public domain meant editing compose and restarting.
 * The admin panel now owns it, which means it has to be read per request and
 * stored somewhere writable -- `data/site.json`, next to the admin credential
 * and the catalogs, so it survives a container rebuild.
 *
 * Precedence is deliberate: an explicit `SITE_URL` env var wins over the stored
 * value. A deployment that pins the origin (CI, a read-only or ephemeral
 * filesystem) must not be silently overridden by a file a previous admin left
 * behind.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Production origin, used when neither the env var nor the file says anything. */
export const DEFAULT_SITE_URL = 'https://ui2.mahabodhi.co';

export const SITE_NAME = '妙境法軒';

/** Subtitle used in the header, the share card and the manifest description. */
export const SITE_SUBTITLE = '玅境長老經典講記講述';

export const SITE_DESCRIPTION =
  '玅境長老經典講記典藏平台：完整收錄 fayun.org 之佛法經論、禪修止觀、戒律與專題開示，' +
  '提供 MP3 音訊、影音講記與 PDF 講義的線上研讀。';

const SETTINGS_DIR = path.join(process.cwd(), 'data');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'site.json');

/** Where the operator's canonical URL is stored. */
export function getSiteSettingsFile(): string {
  const configured = (process.env.SITE_SETTINGS_FILE || '').trim();
  return configured || SETTINGS_FILE;
}

/**
 * Normalise a user-supplied origin.
 *
 * Accepts a bare host, tolerates a pasted path or trailing slash, and rejects
 * anything that is not http(s) with a resolvable host. Rejecting rather than
 * silently falling back matters on write: an admin who types garbage must be
 * told, not have their change quietly discarded.
 */
export function normalizeSiteUrl(
  input: string
): { ok: true; value: string } | { ok: false; message: string } {
  const raw = (input || '').trim();
  if (!raw) return { ok: false, message: '請輸入網址，例如 https://ui2.mahabodhi.co' };
  if (raw.length > 2048) return { ok: false, message: '網址過長。' };

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, message: '網址格式不正確。' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, message: '只接受 http:// 或 https:// 網址。' };
  }
  if (!parsed.hostname) {
    return { ok: false, message: '網址缺少主機名稱。' };
  }
  // A bare "localhost" is legitimate for a LAN install, so it is allowed; but a
  // value with no dot and no scheme was almost certainly a typo.
  if (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost') {
    return {
      ok: false,
      message: '主機名稱不完整（例如少了網域後綴）。'
    };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, message: '網址不可包含帳號或密碼。' };
  }
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    return {
      ok: false,
      message: '請只填寫來源（scheme + host + 選用 port），不要包含路徑、參數或錨點。'
    };
  }

  return { ok: true, value: parsed.origin };
}

export interface StoredSiteSettings {
  /** Origin as last written by the admin, or null when never set. */
  siteUrl: string | null;
  updatedAt: string | null;
}

/** Read the stored settings. Never throws; a broken file reads as "unset". */
export function readStoredSiteSettings(): StoredSiteSettings {
  const empty: StoredSiteSettings = { siteUrl: null, updatedAt: null };
  try {
    const text = fs.readFileSync(getSiteSettingsFile(), 'utf-8');
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return empty;
    const record = parsed as Record<string, unknown>;
    const candidate = typeof record.siteUrl === 'string' ? record.siteUrl : '';
    const normalized = normalizeSiteUrl(candidate);
    return {
      // A hand-edited invalid value is ignored rather than propagated into
      // <link rel="canonical">, which would be worse than the default.
      siteUrl: normalized.ok ? normalized.value : null,
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null
    };
  } catch {
    return empty;
  }
}

export type SiteUrlSource = 'environment' | 'settings' | 'default';

export interface ResolvedSiteUrl {
  origin: string;
  source: SiteUrlSource;
}

/**
 * Resolve the effective canonical origin and where it came from.
 *
 * The provenance is surfaced in the admin panel: an operator whose env var
 * overrides the form needs to see why their saved value has no effect.
 */
export function resolveSiteUrl(): ResolvedSiteUrl {
  const fromEnv = (process.env.SITE_URL || '').trim();
  if (fromEnv) {
    const normalized = normalizeSiteUrl(fromEnv);
    // An explicitly configured but broken SITE_URL still pins the origin; the
    // default is better than serving a malformed canonical tag.
    return { origin: normalized.ok ? normalized.value : DEFAULT_SITE_URL, source: 'environment' };
  }

  const stored = readStoredSiteSettings();
  if (stored.siteUrl) return { origin: stored.siteUrl, source: 'settings' };

  return { origin: DEFAULT_SITE_URL, source: 'default' };
}

/** Absolute origin with no trailing slash. */
export function siteUrl(): string {
  return resolveSiteUrl().origin;
}

/** Absolute URL for a path on the canonical origin. */
export function absoluteUrl(pathname: string): string {
  const base = siteUrl();
  if (!pathname || pathname === '/') return `${base}/`;
  return `${base}${pathname.startsWith('/') ? '' : '/'}${pathname}`;
}

/**
 * Persist the canonical origin.
 *
 * Writes a temp file in the same directory and renames it, so a concurrent
 * request never reads a half-written settings file and falls back to the
 * default origin mid-flight.
 */
export function writeStoredSiteUrl(
  origin: string
): { ok: true } | { ok: false; message: string } {
  const file = getSiteSettingsFile();
  const dir = path.dirname(file);
  const temp = path.join(dir, `.site.json.${process.pid}.${Date.now()}.tmp`);

  const payload = JSON.stringify(
    { siteUrl: origin, updatedAt: new Date().toISOString() },
    null,
    2
  );

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(temp, `${payload}\n`, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(temp, file);
    return { ok: true };
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Best effort; the temp file is named predictably enough to clean up.
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message };
  }
}

/** Remove the stored override so the default (or env var) applies again. */
export function clearStoredSiteUrl(): { ok: true } | { ok: false; message: string } {
  try {
    fs.rmSync(getSiteSettingsFile(), { force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
