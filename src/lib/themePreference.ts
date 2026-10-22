import type { ThemeType } from '@/types/course';

/**
 * Theme preferences and their resolution.
 *
 * The stored value and the applied CSS class are deliberately separate types:
 * `system` is a preference, not a theme. Persisting `system` and resolving it at
 * render time (rather than writing `light`/`dark` on mount) is what makes the
 * site follow the OS when a user switches appearance at sunset without
 * reloading the page.
 */

export type ThemePreference = ThemeType | 'system';

export const THEME_PREFERENCES: ThemePreference[] = [
  'system',
  'dark',
  'light',
  'pine',
  'sandalwood',
  'zen',
  'gruvbox'
];

export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'dark';

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_PREFERENCES as string[]).includes(value);
}

/**
 * Resolves a preference to the concrete theme to apply.
 *
 * `system` maps to `dark`/`light` only — the themed palettes (pine, gruvbox…) are
 * opinionated choices a user makes explicitly, so the OS preference must never
 * silently pick one of them.
 */
export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean
): ThemeType {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light';
  return preference;
}

/** Reads the OS appearance preference, defaulting to dark when unavailable. */
export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return true;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return true;
  }
}

/** Human-readable label for the settings panel. */
export const THEME_LABELS: Record<ThemePreference, { icon: string; name: string; tag: string }> = {
  system: { icon: '🖥️', name: '跟隨系統', tag: '自動' },
  dark: { icon: '🌙', name: '玄夜禪月', tag: '深色' },
  light: { icon: '☀️', name: '淨白雲卷', tag: '淺色' },
  pine: { icon: '🍃', name: '松林竹韻', tag: '竹綠' },
  sandalwood: { icon: '🪵', name: '古木沉香', tag: '茶木' },
  zen: { icon: '🍵', name: '日式禪風', tag: '和風抹茶' },
  gruvbox: { icon: '🌾', name: 'Gruvbox', tag: '復古暖調' }
};
