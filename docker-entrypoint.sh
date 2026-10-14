#!/bin/sh
# Container entrypoint.
#
# Ensures the mounted ./data volume is writable by the unprivileged "node" user,
# then drops privileges to it and execs the real command.
#
# Why this exists: `./data` is a bind mount from the host, so the container does
# not control its ownership. The image runs as uid 1000 (node); when the mount is
# owned by a different uid, the app cannot create data/logs/scan.lock and every
# maintenance trigger failed with "A scan or repair task is already running" — a
# permission problem reported as a concurrency conflict.
#
# Root is used only for the ownership fix-up below; the application process
# itself always runs as "node". When the image is started directly as a
# non-root user this whole block is skipped.
set -eu

APP_UID=$(id -u node)
APP_GID=$(id -g node)
DATA_DIR="${DATA_DIR:-/app/data}"
# Only these directories need to be writable; the media cache is large and its
# existing files must not be walked or rewritten.
WRITABLE_DIRS="$DATA_DIR $DATA_DIR/logs $DATA_DIR/media_cache"

if [ "$(id -u)" = "0" ]; then
    for d in $WRITABLE_DIRS; do
        mkdir -p "$d"
        # Non-recursive: touches only the directory entries, never the cached
        # media files (the cache can hold 20 GB).
        chown "$APP_UID:$APP_GID" "$d" 2>/dev/null || true
    done

    # Re-own the FILES directly inside $DATA_DIR and $DATA_DIR/logs.
    #
    # chown on a directory does not change what is already inside it. So a
    # root-owned scanner.log survived the block above, and because scanner.log is
    # appended IN PLACE it needs WRITE on the FILE — unlike the catalog, which is
    # published by rename and needs only WRITE on the directory. Every append
    # therefore failed with EACCES while the old tail still rendered perfectly,
    # which is what made the log window look frozen and the volume look healthy.
    #
    # The media cache is deliberately excluded: it holds up to 20 GB of files,
    # this loop is not recursive, and the app owns everything it creates there.
    for f in "$DATA_DIR"/* "$DATA_DIR"/.[!.]* "$DATA_DIR/logs"/* "$DATA_DIR/logs"/.[!.]*; do
        [ -f "$f" ] || continue
        chown "$APP_UID:$APP_GID" "$f" 2>/dev/null || true
    done

    # Report a genuinely unusable volume here rather than letting it surface as
    # a misleading "task already running" the first time someone clicks a button.
    if ! su-exec "$APP_UID:$APP_GID" sh -c "touch '$DATA_DIR/logs/.write-probe' && rm -f '$DATA_DIR/logs/.write-probe'"; then
        echo "[entrypoint] ERROR: $DATA_DIR/logs is not writable by uid $APP_UID." >&2
        echo "[entrypoint] Scan/repair triggers will fail. Fix with: chown -R $APP_UID:$APP_GID <host-data-dir>" >&2
    fi

    # Probe the log FILE too. Creating the probe above only proved the directory
    # is writable; scanner.log is appended in place, so it needs file write. Left
    # unchecked, an unappendable log silently discards every new line and the UI
    # shows a stale tail that looks like a rendering bug.
    if [ -e "$DATA_DIR/logs/scanner.log" ] && \
       ! su-exec "$APP_UID:$APP_GID" sh -c "[ -w '$DATA_DIR/logs/scanner.log' ]"; then
        echo "[entrypoint] WARNING: $DATA_DIR/logs/scanner.log is not writable by uid $APP_UID." >&2
        echo "[entrypoint] Log lines will not appear. Fix with: chown $APP_UID:$APP_GID '$DATA_DIR/logs/scanner.log'" >&2
    fi

    # Drop privileges; tini becomes PID 1 and reaps the spawned Python workers.
    exec su-exec "$APP_UID:$APP_GID" "$@"
fi

exec "$@"
