#!/usr/bin/env python3
"""
Fayun Media Background Scanner Daemon

Runs a scan, then repeats every 24 hours (86400 seconds). This daemon is not
referenced by the Next.js app or the Docker image; it exists for deployments
that want an always-on scheduler instead of the on-demand /api/scan trigger.
"""

import os
import sys
import time
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import media_common as mc
import scan_fayun as sf

INTERVAL_SECONDS = 86400  # 24 hours


def main():
    mc.log("🚀 Fayun Media 24-Hour Scanner Daemon Started.")
    while True:
        # Go through scan_fayun.main() so the daemon takes the SAME catalog lock
        # as /api/scan. Calling run_scan() directly bypassed the lock entirely,
        # so a scheduled run could write concurrently with a manual one and
        # splice the catalog.
        try:
            rc = sf.main()
            if rc == mc.EXIT_BUSY:
                # Someone else holds the lock. Do not spin: retry in an hour.
                mc.log("⏳ 掃描鎖被其他程序持有，1 小時後重試。")
                if _sleep(3600):
                    return
                continue
        except Exception as e:
            mc.log(f"❌ Daemon encountered error during scan: {e}")

        nxt = datetime.fromtimestamp(time.time() + INTERVAL_SECONDS).strftime("%Y-%m-%d %H:%M:%S")
        mc.log(f"⏳ Sleeping for 24 hours (86,400s)... Next scheduled scan at {nxt}")
        # Sleep inside the loop: it used to sit after run_scan() inside the same
        # try, so an exception during the scan skipped the sleep entirely and the
        # daemon hot-looped against the network. An interrupt is a clean shutdown.
        if _sleep(INTERVAL_SECONDS):
            return


def _sleep(seconds):
    """Sleeps, returning True if interrupted (so the caller can shut down)."""
    try:
        time.sleep(seconds)
        return False
    except KeyboardInterrupt:
        mc.log("🛑 Daemon interrupted; shutting down.")
        return True


if __name__ == "__main__":
    main()
