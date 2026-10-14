#!/usr/bin/env python3
"""
Fayun Catalog Automated Verification & Self-Healing Engine
Scans all 414 courses across Audio, Video, and PDF note links.
Detects 404s, invalid HTML SPA fallbacks, and wrong URL patterns.
Queries fayun.org list.php dynamically to repair broken URLs and updates src/data/courses_db.json.
"""

import os
import sys
import json
import time
import urllib.request
import urllib.parse
import re
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import media_common as mc

# Locations, exit codes and shared helpers come from media_common so this script
# and scan_fayun.py cannot disagree about which file they are healing.
PROJECT_DIR = mc.PROJECT_DIR
DATA_DIR = mc.DATA_DIR
DB_PATH = mc.DB_PATH
SRC_DB_PATH = mc.SRC_DB_PATH
LOG_DIR = mc.LOG_DIR
LOG_PATH = mc.LOG_PATH
EXIT_BUSY = mc.EXIT_BUSY

# Create data/ and data/logs/ up front (the old module did this with its own
# os.makedirs calls; ensure_dirs never raises if the tree is not writable).
mc.ensure_dirs()

# The legacy auto_heal.log merge block was removed: it used a bare
# ``except: pass`` and deleted the old log even when the append had partially
# failed, which could lose every historical entry. media_common.log owns logging
# now, so nothing here needs to rewrite log files.


def log(msg):
    """Kept as a thin wrapper so existing call sites keep working."""
    mc.log(msg)


def rotate_log_if_needed():
    mc.rotate_log_if_needed()


def quote_url(url):
    """
    Percent-encodes a URL path without re-encoding existing escapes.

    urllib.parse.quote() defaults to safe="/", which also encodes the '%' of an
    already-encoded sequence: "%20" became "%2520". Six stored URLs contain a
    literal '%', and re-quoting them produced a 404. Keeping '%' in `safe` makes
    this function idempotent, so the string we probe is the string we store.
    """
    parts = urllib.parse.urlsplit(url)
    quoted_path = urllib.parse.quote(parts.path, safe="/%:@&=+$,;~()!*'")
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, quoted_path, parts.query, parts.fragment))


def verify_media_url(url):
    """
    Verifies if a media or PDF URL is valid and actually serves binary content.
    Returns (is_valid: bool, status_reason: str)

    A 206 Partial Content is a success (the Range header asks for bytes 0-100 and
    urlopen does not raise for it). A Content-Type header alone is not proof that
    the body is the real file, so this only rejects the one case that is reliably
    detectable: the text/html SPA fallback. Everything else is accepted, as before.
    """
    if not url or not url.startswith("http"):
        return False, "Empty or invalid URL scheme"

    try:
        # Probe exactly the string callers store. quote_url is idempotent, so an
        # already-encoded URL is not altered here and a verified URL cannot drift
        # from the one written to the catalog.
        qurl = quote_url(url)
        req = urllib.request.Request(
            qurl,
            headers={"User-Agent": "Mozilla/5.0", "Range": "bytes=0-100"},
            method="GET"
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            ctype = resp.headers.get("Content-Type", "").lower()
            if "text/html" in ctype:
                return False, "Returned HTML SPA fallback page"
            return True, f"Valid ({ctype})"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}"
    except Exception as e:
        return False, str(e)

LIST_PHP_URL = "https://www.fayun.org/public/php/list.php"
AUDIO_EXTS = (".mp3", ".m4a", ".wav", ".wma", ".aac", ".ogg", ".mp4", ".m4v", ".webm")

def query_remote_list(src_path):
    """
    Queries fayun.org list.php for file listings inside a directory path.
    Returns:
      - list/dict if directory exists and has entries
      - [] if directory explicitly returned 400 or empty data
      - None if network error / timeout occurred
    """
    if not src_path:
        return None

    try:
        req = urllib.request.Request(
            LIST_PHP_URL,
            data=json.dumps({"src": src_path}).encode("utf-8"),
            headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"}
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            res = json.loads(resp.read().decode("utf-8"))
            if isinstance(res, dict) and "data" in res:
                return res["data"]
            elif isinstance(res, list):
                return res
            return []
    except urllib.error.HTTPError as e:
        if e.code == 400:
            return []
        return None
    except Exception:
        return None

def course_matches_filename(c_name, fname):
    """
    Robust matching of course titles and filenames, handling sutra prefixes like 雜阿含經．
    """
    if not c_name or not fname:
        return False
    if c_name in fname:
        return True
    parts = [p.strip() for p in re.split(r"[．·\.\:\s\-_/\\()（）]+", c_name) if len(p.strip()) >= 2]
    return any(p in fname for p in parts)

def extract_fname(item):
    """
    Normalises a list.php entry to a filename string.

    Entries may be strings, dicts, or neither; returning "" for anything unknown
    keeps callers safe, because a bare item.get(...) or .lower() on a non-dict
    raised AttributeError and the per-course try silently skipped the course.
    """
    if isinstance(item, str):
        return item
    if isinstance(item, dict):
        name = item.get("name", "")
        return name if isinstance(name, str) else ""
    return ""

def find_real_pdfs_for_course(course):
    """
    Discovers all real, verified PDF files for a course from fayun.org remote directory.
    """
    audio_path = course.get("audio_path")
    video_path = course.get("video_path")
    lecture_path = course.get("lecture_path")

    potential_paths = []
    if lecture_path:
        potential_paths.append(lecture_path)

    if audio_path:
        parent = audio_path.split("/audio")[0]
        potential_paths.extend([parent, f"{parent}/bilu", f"{parent}/beizhu", f"{parent}/pdf"])

    if video_path:
        parent = video_path.split("/video")[0]
        potential_paths.extend([parent, f"{parent}/bilu", f"{parent}/beizhu", f"{parent}/pdf"])

    unique_paths = list(dict.fromkeys(potential_paths))
    verified_pdfs = []

    for dir_path in unique_paths:
        data = query_remote_list(dir_path)
        if not data:
            continue

        files_with_subfolder = []
        if isinstance(data, list):
            for item in data:
                fname = extract_fname(item)
                if fname.lower().endswith(".pdf"):
                    files_with_subfolder.append((fname, dir_path))
        elif isinstance(data, dict):
            for k, list_val in data.items():
                if isinstance(list_val, list):
                    # Always descend into the returned key. The old code used a
                    # hardcoded ["bilu","beizhu","pdf"] allowlist and left real
                    # keys such as "卷50" or "初發論端" collapsed onto the parent,
                    # so their PDFs got URLs one level too high and always 404ed.
                    sub = f"{dir_path}/{k}"
                    for item in list_val:
                        fname = extract_fname(item)
                        if fname.lower().endswith(".pdf"):
                            files_with_subfolder.append((fname, sub))

        for fname, sub in files_with_subfolder:
            raw_url = f"https://www.fayun.org/ftpadmin{sub}/{fname}"
            # Store the canonical (single-encoded, idempotent) form so the URL we
            # probe is byte-identical to the URL written into the catalog.
            store_url = quote_url(raw_url)
            ok, reason = verify_media_url(store_url)
            if ok:
                if not any(x["url"] == store_url for x in verified_pdfs):
                    verified_pdfs.append({
                        "num": len(verified_pdfs) + 1,
                        "filename": fname,
                        "url": store_url
                    })

    return verified_pdfs

def verify_and_heal_course(course):
    """
    Verifies audio, video, and PDF entries for a course. Repairs any invalid entries.
    Returns (modified: bool, repair_notes: str)
    """
    course_name = course.get("name", "")
    modified = False
    notes = []

    # 1. Audit PDF Links
    pdfs = course.get("pdfs", [])
    if not isinstance(pdfs, list):
        pdfs = []

    failed_pdf_urls = []
    if pdfs:
        # Verify EVERY stored PDF, not just pdfs[0]. A single transient timeout on
        # the first entry used to trigger a full rebuild that could return [] and
        # wipe a curated list (2089 stored URLs; 9 courses live under directories
        # the finder can never query, one with 503 PDFs).
        for entry in pdfs:
            # Entries are not guaranteed to be dicts, so a bare .get() would raise
            # AttributeError and the per-course try would silently skip the course.
            url = entry.get("url") if isinstance(entry, dict) else None
            ok, reason = verify_media_url(url)
            if not ok:
                failed_pdf_urls.append((url, reason))

    if not pdfs or failed_pdf_urls:
        if failed_pdf_urls:
            notes.append(f"PDF link invalid ({failed_pdf_urls[0][1]})")
        real_pdfs = find_real_pdfs_for_course(course)
        if not real_pdfs:
            if pdfs:
                # The finder returning [] is NOT evidence that the stored links are
                # dead -- it simply cannot reach every directory. Replacing a
                # non-empty list with [] destroyed valid data, so keep the list.
                notes.append("PDF probe failed but finder returned no replacements; kept existing PDFs")
            else:
                notes.append("No PDFs found")
        else:
            course["pdfs"] = real_pdfs
            modified = True
            notes.append(f"Repaired PDFs: {len(real_pdfs)} valid files found")

    # 2. Audit Audio Path
    audio_path = course.get("audio_path")
    if audio_path:
        audio_data = query_remote_list(audio_path)

        # Check if audio_data files actually belong to this course
        is_mismatched = False
        if isinstance(audio_data, list) and len(audio_data) > 0:
            fnames = [extract_fname(f) for f in audio_data]
            matched = any(course_matches_filename(course_name, fn) for fn in fnames)
            if not matched:
                is_mismatched = True

        if audio_data is None:
            # None means the probe itself failed (timeout / network error), which is
            # NOT evidence that the path is wrong. query_remote_list returns [] for a
            # genuinely empty/400 directory, so conflating None with "not found" let a
            # transient blip rewrite a good audio_path. Mirrors the video path below.
            notes.append("Audio directory probe failed (network); skipped audio repair")
        elif is_mismatched or not audio_data:
            # Attempt to find real course directory under parent topic
            parent_dir = audio_path.split("/audio")[0] if "/audio" in audio_path else os.path.dirname(audio_path)
            topic_dir = os.path.dirname(parent_dir)

            candidates = [
                f"{parent_dir}/{course_name}/audio",
                f"{parent_dir}/{course_name}",
                f"{topic_dir}/{course_name}/audio",
                f"{topic_dir}/{course_name}"
            ]

            repaired_path = None
            for cand in candidates:
                cand_data = query_remote_list(cand)
                if isinstance(cand_data, list) and len(cand_data) > 0:
                    cand_fnames = [extract_fname(f) for f in cand_data]
                    if any(course_matches_filename(course_name, fn) for fn in cand_fnames):
                        repaired_path = cand
                        audio_data = cand_data
                        break

            if repaired_path:
                course["audio_path"] = repaired_path
                # The replacement directory matched this course, so the episode count
                # below may safely use it.
                is_mismatched = False
                modified = True
                notes.append(f"Repaired mismatched audio_path to {repaired_path}")
            elif not audio_data and "/audio" in audio_path:
                parent = audio_path.split("/audio")[0]
                alt_data = query_remote_list(parent)
                # Only fall back to the parent when it really lists audio files, and
                # only when it is a list: a dict response is a set of subdirectories,
                # not episodes. The old code accepted any truthy value and pointed
                # audio_path at a directory whose files live under /audio, leaving
                # audio_data as the stale value so the episode recount was skipped.
                if isinstance(alt_data, list) and any(
                    extract_fname(f).lower().endswith(AUDIO_EXTS) for f in alt_data
                ):
                    course["audio_path"] = parent
                    audio_data = alt_data
                    modified = True
                    notes.append(f"Repaired audio_path to {parent}")

        if isinstance(audio_data, list) and not is_mismatched:
            audio_files = [f for f in audio_data if extract_fname(f).lower().endswith(AUDIO_EXTS)]
            old_count = course.get("total_episodes")
            if len(audio_files) > 0 and old_count != len(audio_files):
                # Never let the count grow from this listing: the directory also holds
                # QA/companion audio artifacts that are not episodes (a live run grew
                # id 113 from 14 to 42). Only initialise a missing count, or reduce an
                # inflated one. Skipped entirely when the directory was mismatched,
                # because then the files belong to some other course.
                if not isinstance(old_count, int) or old_count <= 0 or len(audio_files) < old_count:
                    course["total_episodes"] = len(audio_files)
                    modified = True
                    notes.append(f"Updated audio total_episodes: {old_count} -> {len(audio_files)}")

    # 3. Audit Video Path safely (never clear on network error)
    video_path = course.get("video_path")
    if video_path:
        vdata = query_remote_list(video_path)
        # Only inspect if query returned an explicit empty list (server 400 or empty directory)
        if vdata is not None and len(vdata) == 0:
            parent = video_path.split("/video")[0]
            vdata_parent = query_remote_list(parent)
            if isinstance(vdata_parent, dict) and "video" in vdata_parent and len(vdata_parent["video"]) > 0:
                repaired = f"{parent}/video"
                if course.get("video_path") != repaired:
                    course["video_path"] = repaired
                    modified = True
                    notes.append(f"Repaired video_path to {repaired}")
            elif vdata_parent is not None and (len(vdata_parent) == 0 or (isinstance(vdata_parent, dict) and "video" not in vdata_parent)):
                course["video_path"] = None
                modified = True
                notes.append("Cleared invalid video_path (verified absent on server)")

    return modified, "; ".join(notes)

def _auto_heal_locked():
    """The actual heal pass. Callers must already hold the catalog lock."""
    log("🚑 === 開始執行全站自我巡檢與目錄自動修復 ===")

    # load_catalog quarantines a truncated/non-object database and recovers from
    # the bundled src copy; the old unguarded json.load crashed every run on such
    # a file (and on a top-level list at db.get), leaving it in place.
    db, source = mc.load_catalog()
    courses = db.get("courses", [])

    if source == "empty" and not courses:
        # No primary file and no usable bundled copy: report the same condition the
        # old "Database file not found!" check did, instead of publishing an empty
        # catalog over data the operator may still be able to recover.
        log("❌ Database file not found!")
        return {"status": "error", "message": "Database file not found"}

    total_courses = len(courses)

    log(f"📋 Loaded {total_courses} courses for integrity verification.")

    total_repaired = 0
    repaired_details = []

    for idx, course in enumerate(courses):
        try:
            modified, notes = verify_and_heal_course(course)
            if modified:
                total_repaired += 1
                repaired_details.append({
                    "id": course["id"],
                    "name": course["name"],
                    "notes": notes
                })
                log(f"🔧 [修復路徑] ID: {course['id']} | 完整名稱: '{course['name']}' | 分類: {course.get('main_menu_title','')} ➔ {course.get('sub_menu_title','')} | 修復結果: {notes}")
        except Exception as e:
            log(f"⚠️ Error auditing course {course.get('name')}: {e}")

    db["courses"] = courses
    db["last_auto_healed_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    db["total_repaired_courses"] = total_repaired

    # Unique-temp atomic write with surrogate handling, shared with scan_fayun.py.
    mc.write_json_atomic(DB_PATH, db)

    # The src copy is git-tracked, but it is synchronised deliberately; route it
    # through media_common so it gets the same atomic write instead of the old
    # fixed-name temp file that two runs could interleave on.
    if os.path.exists(SRC_DB_PATH):
        mc.sync_to_src(db)

    summary_msg = f"✅ Self-Healing Complete! Audited: {total_courses} | Repaired: {total_repaired}"
    log(summary_msg)

    return {
        "status": "success",
        "total_audited": total_courses,
        "total_repaired": total_repaired,
        "timestamp": db["last_auto_healed_at"],
        "details": repaired_details
    }

def run_auto_heal():
    # One maintenance run at a time: a scheduled daemon and a web-triggered run
    # could otherwise write the same database simultaneously and publish a spliced
    # file. Non-blocking, so a second run exits with a distinct busy code.
    try:
        with mc.catalog_lock():
            return _auto_heal_locked()
    except mc.CatalogBusy as e:
        print(f"⚠️ Another catalog task already holds the lock (auto-heal aborted): {e}", flush=True)
        sys.exit(mc.EXIT_BUSY)

if __name__ == "__main__":
    run_auto_heal()
    # Explicit success exit so callers can tell a clean run from a crash.
    sys.exit(0)
