#!/usr/bin/env python3
"""
Shared helpers for the Fayun maintenance scripts (scan_fayun.py, auto_heal_catalog.py).

Consolidates four things that were previously duplicated, subtly divergent, and
individually buggy in both scripts:

  1. An exclusive catalog lock. Neither script had any lock at all, while the
     Node lock in src/lib/serverTasks.ts only guards the two API routes. A
     scheduled daemon run and a web-triggered run could therefore write the same
     database simultaneously and publish a spliced, unparseable file.
  2. Atomic writes with a UNIQUE temp name. Both used ``f"{target}.tmp"``, so two
     concurrent writers shared one scratch file and one could publish the other's
     half-written bytes.
  3. A tolerant catalog load. Both called ``json.load()`` unguarded, so a
     truncated or non-object database crashed every subsequent run at startup,
     before any network work, with nothing written to the log.
  4. Log rotation. Both had an off-by-one that deleted a backup generation
     instead of shifting it, so ``.3`` was never created and a stale one persisted
     forever.
"""

import errno
import fcntl
import json
import os
import sys
import time
import uuid
from datetime import datetime

# --------------------------------------------------------------------------- #
# Locations
#
# PROJECT_DIR may be overridden so tests (and any future non-cwd deployment) can
# point the scripts at a disposable tree. TASK_LOG_DIR is honoured because the
# Node side already uses it, and the two diverging meant the lock/log location
# and the Python log could split across different directories.
# --------------------------------------------------------------------------- #

PROJECT_DIR = os.environ.get("FAYUN_PROJECT_DIR") or os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))
)
DATA_DIR = os.path.join(PROJECT_DIR, "data")
SRC_DB_PATH = os.path.join(PROJECT_DIR, "src", "data", "courses_db.json")
DB_PATH = os.environ.get("FAYUN_DB_PATH") or os.path.join(DATA_DIR, "courses_db.json")

LOG_DIR = os.environ.get("TASK_LOG_DIR") or os.path.join(PROJECT_DIR, "data", "logs")
LOG_PATH = os.path.join(LOG_DIR, "scanner.log")

# The lock lives next to the database it protects, NOT in the log dir: the lock
# must be shared by every writer of that database even if they log elsewhere.
LOCK_PATH = os.environ.get("FAYUN_LOCK_PATH") or os.path.join(DATA_DIR, "courses_db.lock")

LOG_MAX_BYTES = 5 * 1024 * 1024
LOG_BACKUPS = 3

# Exit code used when another maintenance task already holds the catalog lock.
# Distinct from 1 so callers can tell "lost the race" from "crashed".
EXIT_BUSY = 3


def ensure_dirs():
    """Creates the data and log directories. Never raises."""
    for d in (DATA_DIR, LOG_DIR, os.path.dirname(DB_PATH)):
        try:
            os.makedirs(d, exist_ok=True)
        except Exception:
            pass


# --------------------------------------------------------------------------- #
# Logging
# --------------------------------------------------------------------------- #

def _configure_stdout():
    """
    Makes stdout UTF-8 tolerant.

    The log lines are CJK. Under a C locale (LC_ALL=C with coercion disabled)
    ``sys.stdout`` is ASCII, and ``print()`` raised UnicodeEncodeError *before*
    the surrounding try block, so the message was lost entirely.
    """
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


_configure_stdout()


def rotate_log_if_needed():
    """
    Rolls scanner.log into .1/.2/.3.

    The previous loop iterated ``range(LOG_BACKUPS - 1, 0, -1)`` and, when
    ``i + 1 >= LOG_BACKUPS``, *removed* the numbered file instead of shifting it.
    With LOG_BACKUPS=3 that deleted ``.2`` on every pass and never created ``.3``,
    losing a whole backup generation while leaving a stale ``.3`` on disk.
    """
    try:
        if not os.path.exists(LOG_PATH):
            return
        if os.path.getsize(LOG_PATH) < LOG_MAX_BYTES:
            return
        # Shift .N-1 -> .N downwards. os.replace overwrites, so the oldest
        # generation is discarded naturally and a window of LOG_BACKUPS is kept.
        for i in range(LOG_BACKUPS - 1, 0, -1):
            older = f"{LOG_PATH}.{i}"
            if os.path.exists(older):
                os.replace(older, f"{LOG_PATH}.{i + 1}")
        os.replace(LOG_PATH, f"{LOG_PATH}.1")
    except Exception as e:
        try:
            print(f"Log rotation skipped: {e}", flush=True)
        except Exception:
            pass


def log(message, to_file=True, prefix=""):
    """
    Prints and appends a timestamped log line.

    Swallows all I/O errors: logging must never be the reason a maintenance run
    fails.
    """
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{timestamp}] {prefix}{message}"
    try:
        print(line, flush=True)
    except Exception:
        pass
    if not to_file:
        return
    try:
        ensure_dirs()
        rotate_log_if_needed()
        with open(LOG_PATH, "a", encoding="utf-8", errors="replace") as f:
            f.write(line + "\n")
    except Exception as e:
        # A log file that can be READ but not WRITTEN is why the web log window
        # looked frozen: the tail rendered fine, so everything appeared healthy,
        # while every new line was dropped. It happens when scanner.log is owned
        # by another user (e.g. root-owned on a bind mount). Rebuilding the file
        # through a temp + os.replace needs WRITE on the DIRECTORY only, so the
        # log heals itself instead of staying silent forever.
        try:
            if isinstance(e, PermissionError) or getattr(e, "errno", None) == errno.EACCES:
                existing = ""
                try:
                    with open(LOG_PATH, "r", encoding="utf-8", errors="replace") as f:
                        existing = f.read()
                except Exception:
                    pass
                tmp = f"{LOG_PATH}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp"
                with open(tmp, "w", encoding="utf-8", errors="replace") as f:
                    f.write(existing + line + "\n")
                os.replace(tmp, LOG_PATH)
                print(f"scanner.log was not appendable; replaced it via temp+rename", flush=True)
                return
        except Exception as e2:
            try:
                print(f"Failed to write log: {e2}", flush=True)
            except Exception:
                pass
            return
        try:
            print(f"Failed to write log: {e}", flush=True)
        except Exception:
            pass


# --------------------------------------------------------------------------- #
# Catalog I/O
# --------------------------------------------------------------------------- #

class CatalogError(Exception):
    """The catalog could not be read or is not a JSON object."""


def _quarantine(path, reason):
    """Moves an unusable catalog aside so it cannot crash every future run."""
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = f"{path}.corrupt-{stamp}"
    try:
        os.replace(path, dest)
    except Exception:
        return None
    log(f"⚠️ Quarantined unreadable catalog {path} -> {dest} ({reason})")
    return dest


def _valid_catalog(path):
    """True when `path` holds a JSON object with a `courses` list."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return isinstance(data, dict) and isinstance(data.get("courses"), list)
    except Exception:
        return False


def load_catalog(path=None):
    """
    Loads the catalog, recovering from a corrupt or missing file instead of
    crashing.

    Returns ``(data, source)`` where ``source`` is one of ``"data"``, ``"src"``
    or ``"empty"``. A corrupt primary file is quarantined and, when the bundled
    ``src/data`` copy is healthy, restored from it — the previous unguarded
    ``json.load`` raised on the first run and every run after that, since the
    truncated file was left in place.
    """
    path = path or DB_PATH

    if os.path.exists(path):
        if _valid_catalog(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    return json.load(f), "data"
            except Exception as e:
                _quarantine(path, f"{type(e).__name__}: {e}")
        else:
            _quarantine(path, "not a JSON object with a courses list")

    # Missing or just-quarantined: fall back to the bundled copy.
    if os.path.abspath(path) != os.path.abspath(SRC_DB_PATH) and _valid_catalog(SRC_DB_PATH):
        try:
            with open(SRC_DB_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            log(f"ℹ️ Recovered catalog from bundled source: {SRC_DB_PATH}")
            return data, "src"
        except Exception as e:
            log(f"⚠️ Could not read bundled catalog {SRC_DB_PATH}: {e}")

    log("⚠️ No usable catalog found; starting from an empty one.")
    return {"courses": []}, "empty"


def _strip_surrogates(value):
    """
    Replaces lone surrogates in strings.

    ``json.loads`` happily decodes an escaped ``\\udXXX`` surrogate, but
    ``json.dumps(..., ensure_ascii=False)`` then raises UnicodeEncodeError when
    encoding it to UTF-8, which aborted the write *after* all the scan work.
    """
    if isinstance(value, str):
        return value.encode("utf-8", "replace").decode("utf-8", "replace")
    if isinstance(value, list):
        return [_strip_surrogates(v) for v in value]
    if isinstance(value, dict):
        return {_strip_surrogates(k): _strip_surrogates(v) for k, v in value.items()}
    return value


def write_json_atomic(target_path, payload):
    """
    Writes JSON via a UNIQUE temp file + fsync + os.replace.

    The temp name includes the pid and a random token. The previous fixed
    ``f"{target}.tmp"`` was shared between concurrent runs, and I reproduced a
    published database that failed to parse ("Extra data: line 1 column 1120")
    when two writers interleaved on it.
    """
    directory = os.path.dirname(os.path.abspath(target_path)) or "."
    os.makedirs(directory, exist_ok=True)
    tmp_path = f"{target_path}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp"

    try:
        payload = _strip_surrogates(payload)
        with open(tmp_path, "w", encoding="utf-8") as f:
            try:
                json.dump(payload, f, ensure_ascii=False, indent=2)
            except UnicodeEncodeError:
                # Belt and braces: escape non-encodable text rather than lose the write.
                f.seek(0)
                f.truncate()
                json.dump(payload, f, ensure_ascii=True, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, target_path)
    except Exception:
        try:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
        except Exception:
            pass
        raise


def sync_to_src(payload):
    """
    Mirrors the catalog into the bundled src/data copy, if it exists.

    Kept separate so a read-only or absent src tree never fails a run.
    """
    if not os.path.exists(SRC_DB_PATH):
        return False
    try:
        write_json_atomic(SRC_DB_PATH, payload)
        return True
    except Exception as e:
        log(f"Notice: Could not sync to {SRC_DB_PATH}: {e}")
        return False


# --------------------------------------------------------------------------- #
# Cross-process lock
# --------------------------------------------------------------------------- #

class CatalogBusy(Exception):
    """Another process holds the catalog lock."""


class catalog_lock:
    """
    Exclusive advisory lock over the catalog, held for the whole run.

    Uses ``flock`` on a dedicated lock file rather than the catalog itself, so
    the lock survives the atomic ``os.replace`` that swaps the catalog inode.
    Non-blocking: a second maintenance run exits with EXIT_BUSY instead of
    queueing behind a scan that may take many minutes.
    """

    def __init__(self, path=None, wait_seconds=0.0):
        self.path = path or LOCK_PATH
        self.wait_seconds = wait_seconds
        self._fd = None

    def __enter__(self):
        ensure_dirs()
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self._fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o644)
        deadline = time.time() + max(0.0, self.wait_seconds)
        while True:
            try:
                fcntl.flock(self._fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError as e:
                if e.errno not in (errno.EACCES, errno.EAGAIN):
                    os.close(self._fd)
                    self._fd = None
                    raise
                if time.time() >= deadline:
                    owner = self.read_owner()
                    os.close(self._fd)
                    self._fd = None
                    raise CatalogBusy(
                        f"catalog lock held by another process{owner}"
                    )
                time.sleep(0.2)
        try:
            os.ftruncate(self._fd, 0)
            os.write(
                self._fd,
                json.dumps(
                    {
                        "pid": os.getpid(),
                        "startedAt": datetime.now().isoformat(timespec="seconds"),
                    }
                ).encode("utf-8"),
            )
            os.fsync(self._fd)
        except Exception:
            pass
        return self

    def read_owner(self):
        """Best-effort description of the current holder, for the log."""
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                info = json.load(f)
            return f" (pid {info.get('pid')}, since {info.get('startedAt')})"
        except Exception:
            return ""

    def __exit__(self, exc_type, exc, tb):
        if self._fd is not None:
            try:
                fcntl.flock(self._fd, fcntl.LOCK_UN)
            except Exception:
                pass
            try:
                os.close(self._fd)
            except Exception:
                pass
            self._fd = None
        return False
