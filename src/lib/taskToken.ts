/**
 * Client-side access to the operator-provided task token.
 *
 * The maintenance endpoints (`/api/scan`, `/api/health-check`) and the
 * disk-writing `action=preload` cache warm-up all require a credential
 * (`authorizeTaskRequest`). The browser therefore has to be able to replay it.
 *
 * It lives in localStorage because it has to survive reloads, and it is a
 * deliberately narrow secret: it authorizes cache warm-up and maintenance
 * triggers, nothing else, and the server never sends it back down.
 *
 * When TASK_API_TOKEN is unset the server generates a token per boot and prints
 * it to the log; the operator pastes it into Settings, which writes it here.
 * Until then these calls simply omit the header and the server rejects them,
 * which is the intended failure mode: no request silently acts as if it were
 * authorized.
 */
const STORAGE_KEY = 'fayun_task_token';

/** The stored token, or an empty string when none has been provided. */
export function getStoredTaskToken(): string {
  if (typeof window === 'undefined') return '';
  try {
    return localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    // Storage can throw when disabled by policy or in private mode.
    return '';
  }
}

/** Persists (or, for an empty value, clears) the task token. */
export function setStoredTaskToken(token: string): void {
  if (typeof window === 'undefined') return;
  try {
    const trimmed = token.trim();
    if (trimmed) localStorage.setItem(STORAGE_KEY, trimmed);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

/**
 * Headers carrying the task token, or an empty object when unset.
 *
 * Returning an empty object rather than a placeholder keeps an unauthenticated
 * request genuinely unauthenticated.
 */
export function taskTokenHeaders(): Record<string, string> {
  const token = getStoredTaskToken();
  return token ? { 'X-Task-Token': token } : {};
}
