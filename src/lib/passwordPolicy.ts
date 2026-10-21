/**
 * Password policy bounds shared by the server and the browser.
 *
 * This module is deliberately dependency-free: it is imported by client
 * components, and `@/lib/adminPassword` pulls in `crypto`/`fs`, which a browser
 * bundle cannot resolve. Keeping the bounds here means the UI hint, the client
 * pre-check and the server enforcement can no longer drift apart — they were
 * three separate hard-coded `12`s before.
 */

/** Minimum length enforced by the CLI, the HTTP routes and the setup form. */
export const MIN_ADMIN_PASSWORD_LENGTH = 8;

/** Upper bound; also the `maxLength` of every password input. */
export const MAX_ADMIN_PASSWORD_LENGTH = 256;
