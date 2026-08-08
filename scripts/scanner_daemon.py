#!/usr/bin/env python3
"""
Fayun Media Background Scanner Daemon
Runs a scan immediately upon launch, then repeats every 24 hours (86400 seconds).
"""

import sys
import time
import os
from datetime import datetime

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(PROJECT_DIR, "scripts"))

from scan_fayun import run_scan, log_message

INTERVAL_SECONDS = 86400  # 24 Hours

def main():
    log_message("🚀 Fayun Media 24-Hour Scanner Daemon Started.")
    while True:
        try:
            run_scan()
        except Exception as e:
            log_message(f"❌ Daemon encountered error during scan: {e}")
        
        log_message(f"⏳ Sleeping for 24 hours (86,400s)... Next scheduled scan at {datetime.fromtimestamp(time.time() + INTERVAL_SECONDS).strftime('%Y-%m-%d %H:%M:%S')}")
        time.sleep(INTERVAL_SECONDS)

if __name__ == "__main__":
    main()
