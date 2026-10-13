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

    # Report a genuinely unusable volume here rather than letting it surface as
    # a misleading "task already running" the first time someone clicks a button.
    if ! su-exec "$APP_UID:$APP_GID" sh -c "touch '$DATA_DIR/logs/.write-probe' && rm -f '$DATA_DIR/logs/.write-probe'"; then
        echo "[entrypoint] ERROR: $DATA_DIR/logs is not writable by uid $APP_UID." >&2
        echo "[entrypoint] Scan/repair triggers will fail. Fix with: chown -R $APP_UID:$APP_GID <host-data-dir>" >&2
    fi

    # Drop privileges; tini becomes PID 1 and reaps the spawned Python workers.
    exec su-exec "$APP_UID:$APP_GID" "$@"
fi

exec "$@"
