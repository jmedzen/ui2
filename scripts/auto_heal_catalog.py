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
from datetime import datetime

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(PROJECT_DIR, "src", "data", "courses_db.json")
LOG_PATH = os.path.join(PROJECT_DIR, "auto_heal.log")
LIST_PHP_URL = "https://www.fayun.org/public/php/list.php"

AUDIO_EXTS = ('.mp3', '.m4a', '.aac', '.ogg', '.wav', '.wma', '.flac', '.mp4', '.m4v', '.webm', '.mov')
VIDEO_EXTS = ('.mp4', '.m4v', '.wmv', '.flv', '.mov', '.avi', '.mkv', '.webm')

def log(msg):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{timestamp}] {msg}"
    print(line)
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(line + "\n")

def quote_url(url):
    parts = urllib.parse.urlsplit(url)
    quoted_path = urllib.parse.quote(parts.path)
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, quoted_path, parts.query, parts.fragment))

def verify_media_url(url):
    """
    Verifies if a media or PDF URL is valid and actually serves binary content.
    Returns (is_valid: bool, status_reason: str)
    """
    if not url or not url.startswith("http"):
        return False, "Empty or invalid URL scheme"

    try:
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

def query_remote_list(src_path):
    """
    Queries fayun.org list.php for file listings inside a directory path.
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
    except Exception as e:
        pass
    return None

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
                fname = item if isinstance(item, str) else (item.get("name") if isinstance(item, dict) else "")
                if fname.lower().endswith(".pdf"):
                    files_with_subfolder.append((fname, dir_path))
        elif isinstance(data, dict):
            for k, list_val in data.items():
                if isinstance(list_val, list):
                    sub = f"{dir_path}/{k}" if k in ["bilu", "beizhu", "pdf"] else dir_path
                    for item in list_val:
                        fname = item if isinstance(item, str) else (item.get("name") if isinstance(item, dict) else "")
                        if fname.lower().endswith(".pdf"):
                            files_with_subfolder.append((fname, sub))

        for fname, sub in files_with_subfolder:
            raw_url = f"https://www.fayun.org/ftpadmin{sub}/{fname}"
            # Verify URL
            ok, reason = verify_media_url(raw_url)
            if ok:
                if not any(x["url"] == raw_url for x in verified_pdfs):
                    verified_pdfs.append({
                        "num": len(verified_pdfs) + 1,
                        "filename": fname,
                        "url": raw_url
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
    pdf_needs_repair = False

    if not pdfs:
        pdf_needs_repair = True
    else:
        # Check first PDF item as sample
        sample_pdf = pdfs[0].get("url") if pdfs else None
        ok, reason = verify_media_url(sample_pdf)
        if not ok:
            pdf_needs_repair = True
            notes.append(f"PDF link invalid ({reason})")

    if pdf_needs_repair:
        real_pdfs = find_real_pdfs_for_course(course)
        if real_pdfs != pdfs:
            course["pdfs"] = real_pdfs
            modified = True
            notes.append(f"Repaired PDFs: {len(real_pdfs)} valid files found")

    # 2. Audit Audio Path
    audio_path = course.get("audio_path")
    if audio_path:
        audio_data = query_remote_list(audio_path)
        if not audio_data and "/audio" in audio_path:
            # Try alternate path
            parent = audio_path.split("/audio")[0]
            alt_data = query_remote_list(parent)
            if alt_data:
                course["audio_path"] = parent
                modified = True
                notes.append(f"Repaired audio_path to {parent}")
        elif isinstance(audio_data, list):
            audio_files = [f for f in audio_data if extract_fname(f).lower().endswith(AUDIO_EXTS)]
            if len(audio_files) > 0 and course.get("total_episodes") != len(audio_files):
                course["total_episodes"] = len(audio_files)
                modified = True
                notes.append(f"Updated audio total_episodes: {len(audio_files)}")

    # 3. Audit Video Path
    video_path = course.get("video_path")
    if video_path:
        vdata = query_remote_list(video_path)
        if not vdata:
            # Check if parent contains video
            parent = video_path.split("/video")[0]
            vdata_parent = query_remote_list(parent)
            if vdata_parent and isinstance(vdata_parent, dict) and "video" in vdata_parent:
                course["video_path"] = parent
                modified = True
                notes.append(f"Repaired video_path to {parent}")
            elif not vdata_parent:
                course["video_path"] = None
                modified = True
                notes.append("Cleared invalid video_path")

    return modified, "; ".join(notes)

def extract_fname(item):
    if isinstance(item, str): return item
    if isinstance(item, dict): return item.get("name", "")
    return ""

def run_auto_heal():
    log("🚀 Starting Fayun Catalog Audit & Self-Healing Engine...")

    if not os.path.exists(DB_PATH):
        log("❌ Database file not found!")
        return {"status": "error", "message": "Database file not found"}

    with open(DB_PATH, "r", encoding="utf-8") as f:
        db = json.load(f)

    courses = db.get("courses", [])
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
                log(f"🔧 [{idx+1}/{total_courses}] Repaired '{course['name']}': {notes}")
        except Exception as e:
            log(f"⚠️ Error auditing course {course.get('name')}: {e}")

    db["courses"] = courses
    db["last_auto_healed_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    db["total_repaired_courses"] = total_repaired

    with open(DB_PATH, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=2)

    summary_msg = f"✅ Self-Healing Complete! Audited: {total_courses} | Repaired: {total_repaired}"
    log(summary_msg)

    return {
        "status": "success",
        "total_audited": total_courses,
        "total_repaired": total_repaired,
        "timestamp": db["last_auto_healed_at"],
        "details": repaired_details
    }

if __name__ == "__main__":
    run_auto_heal()
