/**
 * Server-startup maintenance.
 *
 * `register` runs once when a Next.js server instance boots, which is the only
 * reliable place to fix up state left behind by a previous process. Two things
 * are done here:
 *
 * 1. Orphaned locks are cleared. A scan interrupted by `docker compose restart`
 *    left `data/logs/scan.lock` on the mounted volume; because the lock was
 *    judged purely by age, every trigger for the next 30 minutes answered
 *    "A scan or repair task is already running" with nothing actually running.
 *
 * 2. The data directory is probed for writability. Running as the unprivileged
 *    `node` user against a root-owned bind mount is the other way the lock path
 *    fails, and it is better reported once at boot than as a mysterious error
 *    the first time someone presses a maintenance button.
 */
export async function register(): Promise<void> {
  // Only meaningful on the Node.js server; the Edge runtime has no filesystem.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { reclaimOrphanedLock, checkLogDirWritable } = await import('@/lib/serverTasks');

  const probe = checkLogDirWritable();
  if (probe.writable) {
    console.log(`[Boot] Task log directory is writable: ${probe.dir}`);
  } else {
    console.error(
      `[Boot] Task log directory is NOT writable: ${probe.dir} (${probe.error}). ` +
        'Scan and repair triggers will fail until this is fixed. When running under ' +
        'Docker, ensure the ./data bind mount is writable by the container user ' +
        '(see docker-entrypoint.sh).'
    );
  }

  const reclaimed = reclaimOrphanedLock();
  if (reclaimed) {
    console.warn(
      `[Boot] Cleared orphaned maintenance lock from pid ${reclaimed.pid} ` +
        `(started ${reclaimed.startedAt}); no task is running.`
    );
  }
}
