/**
 * Decide which user should own the admin credential file.
 *
 * The container image deliberately has no `USER node` directive: the entrypoint
 * starts as root, aligns the bind-mounted ./data volume, and only then re-execs
 * the app as "node" via su-exec. A side effect is that `docker compose exec`
 * opens a shell as ROOT, so the obvious way to run the password CLI inside the
 * container writes the file as root.
 *
 * The app then cannot read it: the credential is mode 0600 and the app process
 * is uid 1000. The previous code refused to write as root at all, which left a
 * chicken-and-egg problem -- the only identity that can fix the ownership was
 * the one the script declined to run as, and the error only told the operator
 * to re-run from the HOST with `-u node` while they were already inside the
 * container.
 *
 * Root is therefore allowed, but it must also hand the file to the account the
 * app runs as. These helpers are pure so the mapping can be tested without
 * actually being root.
 */

/**
 * Look up an account in /etc/passwd text.
 * @returns {{uid: number, gid: number, name: string} | null}
 */
export function findPasswdEntry(name, passwdText) {
  if (!name) return null;
  for (const line of String(passwdText || '').split('\n')) {
    const parts = line.split(':');
    if (parts.length < 4 || parts[0] !== name) continue;
    const uid = Number(parts[2]);
    const gid = Number(parts[3]);
    if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid < 0 || gid < 0) return null;
    return { uid, gid, name };
  }
  return null;
}

/**
 * Resolve the owner the credential file should be handed to when running as
 * root. Returns null when no suitable account exists, so the caller can warn
 * instead of silently leaving a root-owned file the app cannot read.
 *
 * `ADMIN_FILE_OWNER` may override the account ("node", "1000", or "1000:1000").
 *
 * @param {{ env?: Record<string, string | undefined>, passwdText?: string }} [options]
 * @returns {{uid: number, gid: number, name: string} | null}
 */
export function resolveCredentialOwner(options = {}) {
  const env = options.env || process.env;
  const passwdText = options.passwdText !== undefined ? options.passwdText : '';
  const override = String(env.ADMIN_FILE_OWNER || '').trim();

  if (override) {
    const numeric = /^(\d+)(?::(\d+))?$/.exec(override);
    if (numeric) {
      const uid = Number(numeric[1]);
      const gid = numeric[2] === undefined ? uid : Number(numeric[2]);
      return { uid, gid, name: override };
    }
    return findPasswdEntry(override, passwdText);
  }

  return findPasswdEntry('node', passwdText);
}
