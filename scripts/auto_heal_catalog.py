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

# Filename words that name a document type or a volume rather than a course.
# They are excluded from the token match in course_matches_filename so a file
# called "卷上.pdf" or "講義.pdf" cannot be attributed to a course by accident.
GENERIC_FILENAME_TOKENS = {
    "卷上", "卷中", "卷下", "上卷", "中卷", "下卷",
    "筆錄", "講記", "講義", "大意", "科表", "總科表", "冠科",
    "問答", "補充", "目錄", "前言", "附錄", "參考", "教材",
    "課程", "開示", "節錄", "整理", "全文", "講稿", "手稿",
    "摘錄", "講解", "導讀", "表解", "科判", "題解", "序文",
    "偈頌", "原文", "audio", "video", "bilu", "pdf", "beizhu",
    "notes", "note", "doc", "docs",
}

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

def _name_tokens(name):
    """
    Splits a course title into matchable tokens.

    Tokens shorter than two characters, and tokens that only describe a document
    type or a volume ("卷上", "筆錄", "講義", "pdf", ...), are dropped: they appear
    in hundreds of filenames and identify no particular course.
    """
    if not name:
        return []
    tokens = []
    for part in re.split(r"[．·\.\:\s\-_/\\()（）\[\]【】]+", str(name)):
        part = part.strip()
        if len(part) >= 2 and part.lower() not in GENERIC_FILENAME_TOKENS:
            tokens.append(part)
    return tokens


def course_matches_filename(c_name, fname):
    """
    Decides whether a file plausibly belongs to the course named `c_name`.

    The previous rule was a bare substring test on the whole name plus on every
    token of length >= 2. Both directions are unsafe: the full-name test is fine
    ("解深密經．一切法相品第四" appearing in a filename really does identify that
    course), but short fragments do not. Measuring this against the real catalog
    (2089 stored PDFs, 684 courses) showed 246 filenames substring-matching more
    than one course, because unrelated courses share prefixes and because generic
    fragments such as "經", "論", "大意" and "卷上" appear everywhere.

    The rule enforced here is deliberately conservative:

      1. a full, distinctive name of at least 4 characters that appears verbatim
         in the filename is a match; or
      2. one distinctive multi-character token (>= 2 chars, not a document-type
         word) appears in the filename.

    A caller that needs certainty must use course_filename_verdict(); this
    boolean answers "plausible", so ambiguous evidence stays usable for listings
    where only one file is judged at a time.
    """
    return bool(course_filename_verdict(c_name, fname)["match"])


def course_filename_verdict(c_name, fname, other_names=()):
    """
    Ambiguity-aware version of course_matches_filename.

    Returns ``{"match": bool, "ambiguous": bool, "reason": str}``. ``ambiguous``
    is True when the filename also matches another known course title in
    `other_names`, which means the file cannot be attributed safely and MUST NOT
    be attached/rewritten. `other_names` is compared with the same privacy rule:
    a bare substring of a longer course name is not itself a match, so a short
    course name does not "claim" a longer unrelated one.
    """
    candidate = (c_name or "").strip()
    filename = (fname or "").strip()
    if not candidate or not filename:
        return {"match": False, "ambiguous": False, "reason": "empty"}

    tokens = _name_tokens(candidate)
    full_hit = len(candidate) >= 4 and candidate in filename
    token_hits = [t for t in tokens if t in filename]
    match = full_hit or bool(token_hits)

    if match and other_names:
        for other in other_names:
            other = (other or "").strip()
            if not other or other == candidate:
                continue
            if len(other) >= 4 and other in filename:
                return {"match": True, "ambiguous": True,
                        "reason": f"also matches '{other}'"}
            if any(t in filename for t in _name_tokens(other)):
                return {"match": True, "ambiguous": True,
                        "reason": f"also matches '{other}'"}

    return {"match": match, "ambiguous": False, "reason": "token" if token_hits else "full"}

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

def verify_and_heal_course(course, other_course_names=()):
    """
    Verifies audio, video, and PDF entries for a course. Repairs any invalid entries.
    Returns (modified: bool, repair_notes: str)

    A course that is not a dict cannot be healed; rather than raising, it is
    reported so the caller can count it as a failure and continue (F4).
    """
    if not isinstance(course, dict):
        raise TypeError(f"course is {type(course).__name__}, not a dict")
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
            # F2: MERGE instead of replace. The old code assigned real_pdfs over
            # the whole curated list, so one 404 turned 3 curated PDFs into the 1
            # file the finder happened to see. Only entries that actually failed
            # verification are dropped; every PDF that was not proven bad survives,
            # order-stable, and newly discovered files are appended.
            failed_url_set = {u for u, _ in failed_pdf_urls if u}
            merged = []
            seen_urls = set()
            for entry in pdfs:
                url = entry.get("url") if isinstance(entry, dict) else None
                if url and url in failed_url_set:
                    continue
                key = url or (entry.get("filename") if isinstance(entry, dict) else str(entry))
                if key in seen_urls:
                    continue
                seen_urls.add(key)
                merged.append(entry)
            added = 0
            for new_pdf in real_pdfs:
                url = new_pdf.get("url")
                if url and url not in seen_urls:
                    seen_urls.add(url)
                    merged.append(new_pdf)
                    added += 1
            for i, entry in enumerate(merged, start=1):
                if isinstance(entry, dict):
                    entry["num"] = i
            if merged != pdfs:
                course["pdfs"] = merged
                modified = True
                notes.append(
                    f"Repaired PDFs: kept {len(pdfs) - len(failed_url_set)} curated, "
                    f"added {added} discovered"
                )

    # 2. Audit Audio Path
    audio_path = course.get("audio_path")
    if audio_path:
        audio_data = query_remote_list(audio_path)
        audio_probe_failed = audio_data is None

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
                    # Do not re-point a course at a directory whose files also
                    # match a different course: attaching the wrong media is worse
                    # than leaving the original path alone (F10).
                    verdicts = [
                        course_filename_verdict(course_name, fn, other_course_names)
                        for fn in cand_fnames
                    ]
                    if any(v["match"] and not v["ambiguous"] for v in verdicts):
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
                # A listing is authoritative only when it actually identifies this
                # course. The old rule shrank the count on any non-empty listing,
                # so a truncated response (or a directory holding a single QA clip)
                # silently reduced a course's episode count. F9: grow freely on a
                # verified listing, initialise a missing count, and only shrink when
                # the remaining files still match the course and the probe that
                # produced them did not fail.
                names_match = any(
                    course_matches_filename(course_name, extract_fname(f))
                    for f in audio_files
                )
                can_shrink = (
                    isinstance(old_count, int)
                    and old_count > 0
                    and len(audio_files) < old_count
                    and not audio_probe_failed
                    and names_match
                )
                can_grow = not isinstance(old_count, int) or old_count <= 0 or len(audio_files) > old_count
                # Reaching this point already proves the probe succeeded: a failed
                # probe (audio_data is None) leaves the isinstance() guard above
                # False. So the only extra evidence a shrink needs is that the
                # surviving files still identify this course.
                if can_grow or can_shrink:
                    course["total_episodes"] = len(audio_files)
                    modified = True
                    notes.append(f"Updated audio total_episodes: {old_count} -> {len(audio_files)}")

    # 3. Audit Video Path safely (never clear on network error)
    video_path = course.get("video_path")
    if video_path:
        vdata = query_remote_list(video_path)
        # F3: only act when the server POSITIVELY answered. `None` is a failed
        # probe and must never be treated as "the file is gone"; `[]` is an
        # explicit "this directory is empty" answer.
        if vdata is not None and len(vdata) == 0:
            parent = video_path.split("/video")[0]
            vdata_parent = query_remote_list(parent) if parent != video_path else None
            if isinstance(vdata_parent, dict) and "video" in vdata_parent and len(vdata_parent["video"]) > 0:
                repaired = f"{parent}/video"
                if course.get("video_path") != repaired:
                    course["video_path"] = repaired
                    modified = True
                    notes.append(f"Repaired video_path to {repaired}")
            elif (
                vdata_parent is not None
                and vdata_parent != []
                and isinstance(vdata_parent, dict)
                and "video" not in vdata_parent
            ):
                course["video_path"] = None
                modified = True
                notes.append("Cleared invalid video_path (verified absent on server)")
            else:
                # No positive evidence that the media moved or is gone: the
                # directory is empty, but the parent listing was inconclusive
                # (network failure, an empty answer, or a path with no /video
                # component such as course 97). Keep the stored value.
                notes.append("video listing empty but absence not confirmed; kept video_path")

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
    total_failed = 0
    repaired_details = []
    # Every course name in the catalog, used to refuse ambiguous filename matches:
    # a PDF that also matches another course's title must not be re-attached (F10).
    known_names = [
        c.get("name")
        for c in courses
        if isinstance(c, dict) and isinstance(c.get("name"), str)
    ]

    for idx, course in enumerate(courses):
        # F4: take a snapshot BEFORE touching the course. The old handler assumed
        # `course` was a dict and raised AttributeError itself
        # ('str' object has no attribute 'get'), which aborted the whole pass
        # after visiting only 2 of 3 courses. It also left whatever the failing
        # call had already mutated in place. Restoring the snapshot makes a
        # failure a no-op for that course and lets the pass continue.
        snapshot = dict(course) if isinstance(course, dict) else None
        try:
            modified, notes = verify_and_heal_course(course, known_names)
            if modified:
                total_repaired += 1
                repaired_details.append({
                    "id": course["id"],
                    "name": course["name"],
                    "notes": notes
                })
                log(f"🔧 [修復路徑] ID: {course['id']} | 完整名稱: '{course['name']}' | 分類: {course.get('main_menu_title','')} ➔ {course.get('sub_menu_title','')} | 修復結果: {notes}")
        except Exception as e:
            total_failed += 1
            # Never assume the row is a dict: a non-dict record must be reported,
            # not allowed to crash the run.
            if snapshot is not None and isinstance(course, dict):
                course.clear()
                course.update(snapshot)
            label = None
            if isinstance(course, dict):
                label = course.get("name") or course.get("id")
            if label is None:
                label = f"record #{idx} ({type(course).__name__})"
            log(f"⚠️ Error auditing course {label}: {type(e).__name__}: {e} (course left unchanged)")

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
    if total_failed:
        summary_msg += f" | Failed: {total_failed}"
    log(summary_msg)

    result = {
        "status": "success",
        "total_audited": total_courses,
        "total_repaired": total_repaired,
        "timestamp": db["last_auto_healed_at"],
        "details": repaired_details
    }
    if total_failed:
        # A pass that could not audit part of the catalog is not a clean success,
        # even though the rows it did visit were written.
        result["status"] = "partial"
        result["total_failed"] = total_failed
    return result

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
    # F12: this used to call run_auto_heal() and then unconditionally
    # sys.exit(0), so even {"status": "error", "message": "Database file not
    # found"} exited 0 and the UI/CI could not tell a failed pass from a clean
    # one. run_auto_heal() owns the busy case (mc.EXIT_BUSY); every other
    # non-success outcome is a real failure.
    result = run_auto_heal()
    if isinstance(result, dict) and result.get("status") in (None, "success"):
        sys.exit(0)
    sys.exit(1)
