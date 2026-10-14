#!/usr/bin/env python3
"""
Fayun.org Media Scanner

Scans fayun.org for new courses, audio, video and PDF notes and updates the
catalog. Shared concerns (locking, atomic writes, corrupt-file recovery, log
rotation) live in media_common so this script and auto_heal_catalog.py cannot
diverge from each other again.
"""

import argparse
import json
import os
import re
import sys
import urllib.request
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import media_common as mc

PROJECT_DIR = mc.PROJECT_DIR
# Sourced from media_common so both scripts agree on where the catalog lives.
DB_PATH = mc.DB_PATH
SRC_DB_PATH = mc.SRC_DB_PATH

# Rotate the log once it grows past this size. The log is append-only and was
# never rotated, so it could grow without bound and every /api/scan read had to
# page through an ever-larger file.
LOG_MAX_BYTES = mc.LOG_MAX_BYTES
LOG_BACKUPS = mc.LOG_BACKUPS


def log_message(msg):
    mc.log(msg)


def write_json_atomic(target_path, payload):
    """Delegates to the shared writer (unique temp name + surrogate safety)."""
    mc.write_json_atomic(target_path, payload)


def rotate_log_if_needed():
    mc.rotate_log_if_needed()


DB_ACCESS_URL = "https://www.fayun.org/public/php/dbaccess.php"

MENU_TARGETS = [
    ("dharma", "jing"),
    ("dharma", "lun"),
    ("dharma", "yoga"),
    ("zen", "zhiguan"),
    ("teaching", "kaishi"),
    ("teaching", "story"),
    ("teaching", "fayuzhuji"),
    ("teaching", "shengjing")
]

MENU_MAP = {
    "dharma": {
        "title": "佛法經論",
        "subs": {
            "jing": "解經（經藏）",
            "lun": "釋論（論藏）",
            "yoga": "瑜伽師地論（本地分）"
        }
    },
    "zen": {
        "title": "禪修止觀",
        "subs": {
            "zhiguan": "止觀導覽與實修"
        }
    },
    "teaching": {
        "title": "開示與法語",
        "subs": {
            "kaishi": "專題講座與開示",
            "story": "佛典故事",
            "fayuzhuji": "法語珠璣",
            "shengjing": "玅演勝境"
        }
    }
}

TOPIC_MAP = {
    "ahanjing": "阿含經",
    "bashiguijusong": "八識規矩頌",
    "bendifen": "瑜伽師地論 本地分",
    "borejing": "般若經藏",
    "chan": "禪修止觀",
    "dabei": "大悲心陀羅尼",
    "daniepanjing": "大般涅槃經",
    "experience": "玅演勝境",
    "fahuajing": "法華經",
    "fajujing": "法句經",
    "foyijiaojing": "佛遺教經",
    "jieshenmijing": "解深密經",
    "jinggangjing": "金剛般若波羅蜜經",
    "jingtu": "淨土法門",
    "jingtushiyilun": "淨土十疑論",
    "kaishi": "佛學專題講座",
    "kaishi_jielv": "戒律與修持專題",
    "kaishi_jingtu": "淨土思想專題",
    "kaishi_others": "法會與專題開示",
    "motto": "法語珠璣",
    "others": "其他開示資料",
    "qa": "佛學問答",
    "ruzhonglun": "入中論",
    "shedachenglun": "攝大乘論",
    "story_teller": "佛典與高僧故事",
    "weimojiejing": "維摩詰所說經",
    "xinjing": "般若波羅蜜多心經",
    "yoga": "瑜伽師地論"
}

def fetch_category_media(main_menu, sub_menu):
    req = urllib.request.Request(
        DB_ACCESS_URL,
        data=json.dumps({
            "type": "query",
            "target": "media",
            "params": {"main_menu": main_menu, "sub_menu": sub_menu}
        }).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"}
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        res = json.loads(resp.read().decode("utf-8"))
        if isinstance(res, dict) and "data" in res:
            return res["data"]
        elif isinstance(res, list):
            return res
    return []

PATH_OVERRIDES = {
    14: {
        "audio_path": "/media/止觀坐禪/靜坐漫談/audio",
        "lecture_path": "/media/止觀坐禪/靜坐漫談/bilu"
    },
    97: {
        "audio_path": "/media/釋論/瑜伽師地論・本地分",
        "lecture_path": "/media/釋論/瑜伽師地論・本地分",
        "video_path": "/media/釋論/瑜伽師地論・本地分"
    }
}

def normalize_media_path(p):
    if not p:
        return None
    p = str(p).strip()
    if p and not p.startswith('/'):
        p = '/' + p
    return p


def _is_int(value):
    """True only for a real integer (bool is not an id)."""
    return isinstance(value, int) and not isinstance(value, bool)


def coerce_int(value):
    """
    Best-effort int coercion for upstream numerics.

    ``max(stored_total, api_total)`` raised ``TypeError: '>' not supported
    between instances of 'str' and 'int'`` whenever fayun.org reported a string
    total (verified against the live API). The per-item handler swallowed it and
    dropped the whole row, so one malformed number silently deleted a course.
    Anything that cannot be read as an integer is 0 -- never an exception.
    """
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value) if value == value and value not in (float("inf"), float("-inf")) else 0
    if isinstance(value, str):
        try:
            return int(float(value.strip()))
        except (TypeError, ValueError):
            return 0
    return 0


def keep_non_empty(new_value, old_value):
    """
    Returns `new_value` unless it is empty/None AND an existing value can be kept.

    A transient upstream partial response ("name": null, "topic": "") used to
    blank the curated c_name / topic / *_title fields of every course on every
    scan. An empty fetch result is never an intentional erasure of curated text,
    so the stored value wins; a non-empty fetched value still wins, because that
    is the server genuinely correcting itself.
    """
    if new_value is None or (isinstance(new_value, str) and not new_value.strip()):
        if old_value is not None and not (isinstance(old_value, str) and not old_value.strip()):
            return old_value
    return new_value


def _normalize_id(raw_id):
    """
    Canonical identity for a course id.

    Upstream ids are numeric, but a JSON ``7`` and a string ``"7"`` denote the
    same course. They are normalised to the int so the two spellings cannot
    become two rows that later collide (see the dedupe pass in run_scan).
    """
    if isinstance(raw_id, int) and not isinstance(raw_id, bool):
        return raw_id
    if isinstance(raw_id, float) and raw_id.is_integer():
        return int(raw_id)
    text = str(raw_id).strip()
    if re.fullmatch(r"[+-]?\d+", text):
        return int(text)
    return text


def parse_args(argv=None):
    """
    CLI flags. ``--allow-empty`` is the ONLY way to publish a catalog when
    upstream returned nothing, so an outage can never erase the store by
    accident; it exists for the deliberate case of bootstrapping a brand-new
    install where an empty catalog really is the intended result.
    """
    parser = argparse.ArgumentParser(description="Scan fayun.org and refresh the course catalog.")
    parser.add_argument(
        "--allow-empty",
        action="store_true",
        help="允許在完全抓不到任何項目時仍發佈空白目錄（僅供首次建置使用）",
    )
    return parser.parse_args(argv)


def run_scan(allow_empty=False):
    log_message("🔄 === 開始連線 fayun.org 執行媒體同步與掃描 ===")

    # Tolerant load: a truncated or non-object catalog used to raise here, before
    # any network work, so every later run died the same way and the broken file
    # was left in place. load_catalog() quarantines it and recovers from the
    # bundled src copy when that is healthy.
    existing_db, source = mc.load_catalog()
    if not isinstance(existing_db, dict) or not isinstance(existing_db.get("courses"), list):
        log_message("❌ 無法取得可用的課程資料庫，中止掃描。")
        return {"total": 0, "new": 0, "updated": 0, "error": "no usable catalog"}
    log_message(f"ℹ️ 已載入課程資料庫（來源：{source}，共 {len(existing_db.get('courses', []))} 筆）")

    # Defensive: only rows that are objects carrying an id can be indexed.
    existing_courses = {
        str(c["id"]): c
        for c in existing_db.get("courses", [])
        if isinstance(c, dict) and "id" in c
    }
    new_items_count = 0
    updated_items_count = 0
    # Counts rows actually returned by the API this run. The preservation loop
    # below re-adds every existing course, so `scanned_courses` is never empty
    # and cannot be used to detect a total upstream failure.
    fetched_items_count = 0
    categories_ok = 0

    scanned_courses = []

    for main_menu, sub_menu in MENU_TARGETS:
        # Fetch errors are per-category; a single bad ROW is handled per item
        # below, because previously one malformed row aborted the whole category
        # and silently dropped every remaining new course in it (exit code 0).
        try:
            items = fetch_category_media(main_menu, sub_menu)
        except Exception as e:
            log_message(f"❌ Error fetching {main_menu}/{sub_menu}: {e}")
            continue

        if not isinstance(items, list):
            log_message(f"⚠️ Unexpected response for {main_menu}/{sub_menu}; skipping category.")
            continue
        categories_ok += 1

        for item in items:
            try:
                if not isinstance(item, dict):
                    log_message(f"⚠️ Skipped non-object item in {main_menu}/{sub_menu}.")
                    continue
                c_id = _normalize_id(item.get("id"))
                if c_id is None or (isinstance(c_id, str) and not c_id):
                    log_message(f"⚠️ Skipped item without id in {main_menu}/{sub_menu}.")
                    continue
                c_name = (item.get("name") or "").strip()
                topic = item.get("topic") or ""
                fetched_items_count += 1

                main_title = MENU_MAP.get(main_menu, {}).get("title", main_menu)
                sub_title = MENU_MAP.get(main_menu, {}).get("subs", {}).get(sub_menu, sub_menu)
                topic_title = TOPIC_MAP.get(topic, topic) or "通用主題"

                existing = existing_courses.get(str(c_id))
                c_pdfs = existing.get("pdfs", []) if existing else []

                # F6: an empty/None field in a partial upstream response must not
                # clobber curated text. Preserve the stored value in that case.
                if existing:
                    c_name = keep_non_empty(c_name, existing.get("name"))
                    topic = keep_non_empty(topic, existing.get("topic"))
                    if not main_title:
                        main_title = existing.get("main_menu_title") or main_title
                    if not sub_title:
                        sub_title = existing.get("sub_menu_title") or sub_title
                    # topic_title is derived from the (now effective) topic, so
                    # recompute it and only fall back to the stored title when the
                    # topic itself is unknown and blank.
                    topic_title = TOPIC_MAP.get(topic, topic) or "通用主題"
                    if not topic:
                        topic_title = keep_non_empty(existing.get("topic_title"), topic_title) or topic_title

                audio_p = item.get("audio_path")
                lecture_p = item.get("lecture_path_audio") or item.get("lecture_path_video")
                video_p = item.get("video_path")

                if c_id in PATH_OVERRIDES:
                    if "audio_path" in PATH_OVERRIDES[c_id]:
                        audio_p = PATH_OVERRIDES[c_id]["audio_path"]
                    if "lecture_path" in PATH_OVERRIDES[c_id]:
                        lecture_p = PATH_OVERRIDES[c_id]["lecture_path"]
                    if "video_path" in PATH_OVERRIDES[c_id]:
                        video_p = PATH_OVERRIDES[c_id]["video_path"]

                if existing:
                    # Preserve repaired/corrected paths from the existing database.
                    #
                    # PATH_OVERRIDES is applied just above and was then
                    # unconditionally overwritten by the stored value, so an
                    # override (or any server-side correction) could never take
                    # effect for a course already in the database — only for
                    # brand-new ids. Overrides now win, since they exist precisely
                    # to correct what is stored.
                    override = PATH_OVERRIDES.get(c_id) or {}
                    if existing.get("audio_path") and "audio_path" not in override:
                        audio_p = existing["audio_path"]
                    if existing.get("lecture_path") and "lecture_path" not in override:
                        lecture_p = existing["lecture_path"]
                    if existing.get("video_path") is not None and "video_path" not in override:
                        video_p = existing["video_path"]
                    if existing.get("pdfs"):
                        c_pdfs = existing["pdfs"]
                    # The stored count used to win forever, so a course that
                    # gained lectures upstream kept the old figure permanently
                    # (161 of 684 courses have no audio_path for the healer to
                    # recount from). Trust the API when it reports a larger count,
                    # otherwise keep the stored value, which may hold a manual
                    # correction. Both sides are coerced: the API returns a string
                    # total for some rows, and max() then raised TypeError and the
                    # whole row was skipped.
                    api_total = coerce_int(item.get("total"))
                    stored_total = coerce_int(existing.get("total_episodes"))
                    total_episodes = max(stored_total, api_total)
                else:
                    total_episodes = coerce_int(item.get("total"))

                audio_p = normalize_media_path(audio_p)
                video_p = normalize_media_path(video_p)
                lecture_p = normalize_media_path(lecture_p)

                course_obj = {
                    "id": c_id,
                    "name": c_name,
                    "main_menu": main_menu,
                    "main_menu_title": main_title,
                    "sub_menu": sub_menu,
                    "sub_menu_title": sub_title,
                    "topic": topic,
                    "topic_title": topic_title,
                    "location": item.get("location") or (existing.get("location") if existing else "美國法雲寺禪學院"),
                    "time": item.get("time") or (existing.get("time") if existing else ""),
                    "total_episodes": total_episodes,
                    "audio_path": audio_p,
                    "video_path": video_p,
                    "lecture_path": lecture_p,
                    "poster_path": item.get("poster_path") or (existing.get("poster_path") if existing else None),
                    "comment": item.get("comment") or (existing.get("comment") if existing else None),
                    "pdfs": c_pdfs
                }

                if not existing:
                    new_items_count += 1
                    log_message(f"🆕 [新增媒體] ID: {c_id} | 完整名稱: '{c_name}' | 分類: {main_title} ➔ {sub_title} ➔ {topic_title} | 音訊路徑: {course_obj.get('audio_path')} | 影音路徑: {course_obj.get('video_path')} | 講義路徑: {course_obj.get('lecture_path')}")
                elif existing != course_obj:
                    updated_items_count += 1
                    log_message(f"🔄 [更新同步] ID: {c_id} | 完整名稱: '{c_name}' | 分類: {main_title} ➔ {sub_title} ➔ {topic_title} | 音訊路徑: {course_obj.get('audio_path')} | 集數: {course_obj.get('total_episodes')}")

                scanned_courses.append(course_obj)
            except Exception as e:
                # Per-item: keep processing the rest of the category instead of
                # discarding it, and say which row failed so it can be fixed.
                log_message(f"⚠️ Skipped item in {main_menu}/{sub_menu}: {e}")

    # ------------------------------------------------------------------ #
    # Identity invariant (F7)
    #
    # INVARIANT: within the published catalog every course has a unique integer
    # `id`, ids of existing courses are never changed, and two different courses
    # never collapse onto one id.
    #
    # The old code deduped on str(id) but then renumbered ids to int, so an
    # upstream id of "7" and a stored id of 7 produced two rows whose ids were
    # "7" and 7 while the dedupe set still saw a single id. Ids are canonicalised
    # once (_normalize_id) and deduped explicitly here: fetched rows keep their
    # id, and any row that collides with a *different* course is kept as well
    # under the next free integer instead of being silently discarded.
    # ------------------------------------------------------------------ #
    fetched_by_key = {}
    extra_rows = []
    for c in scanned_courses:
        if not isinstance(c, dict) or "id" not in c:
            continue
        key = str(_normalize_id(c["id"]))
        prev = fetched_by_key.get(key)
        if prev is None:
            fetched_by_key[key] = c
        elif prev.get("name") == c.get("name"):
            # The same course reported by two categories: keep the newest row but
            # never lose the stored PDF list when the new one carries none.
            if not c.get("pdfs") and prev.get("pdfs"):
                c["pdfs"] = prev["pdfs"]
            fetched_by_key[key] = c
        else:
            log_message(
                f"⚠️ 上游以相同 ID {c['id']} 回報兩門不同課程（'{prev.get('name')}' / "
                f"'{c.get('name')}'）；將保留兩門並另編新 ID。"
            )
            extra_rows.append(prev)
            fetched_by_key[key] = c

    # Carry over only the existing courses the scan did NOT return. A row whose
    # id came back from upstream is superseded by the fetched row -- that is how
    # a legitimate rename is applied, and re-adding the stored copy would both
    # duplicate the course and give the stale copy a new id on every rename.
    preserved_count = 0
    for old_c in existing_db.get("courses", []):
        if not isinstance(old_c, dict) or "id" not in old_c:
            log_message("⚠️ Dropped malformed existing course row (missing id).")
            continue
        old_c = dict(old_c)
        old_c["id"] = _normalize_id(old_c["id"])
        key = str(old_c["id"])
        if key not in fetched_by_key:
            fetched_by_key[key] = old_c
            preserved_count += 1

    # Stable, collision-free integer ids. Existing integers win and are never
    # renumbered, so ids stay stable across runs; only duplicates and non-integer
    # ids consume the next free integer (iteration order is the deterministic
    # menu/insertion order above).
    used_ints = set()
    next_free_id = 1

    def _next_free_id():
        nonlocal next_free_id
        while next_free_id in used_ints:
            next_free_id += 1
        used_ints.add(next_free_id)
        return next_free_id

    final_courses = []
    for c in list(fetched_by_key.values()) + extra_rows:
        c_id = c.get("id")
        if _is_int(c_id) and c_id not in used_ints:
            used_ints.add(c_id)
        else:
            c["id"] = _next_free_id()
        final_courses.append(c)
    scanned_courses = final_courses
    log_message(
        f"ℹ️ 課程識別整理完成：保留既有 {preserved_count} 筆、"
        f"另編新 ID {len(extra_rows)} 筆、共 {len(scanned_courses)} 筆。"
    )

    def _sort_key(c):
        return (
            str(c.get("main_menu") or ""),
            str(c.get("sub_menu") or ""),
            str(c.get("topic") or ""),
            str(c.get("name") or ""),
        )

    scanned_courses.sort(key=_sort_key)

    # Carry over EVERY unknown top-level key, not just the two known ones, so
    # metadata written by other tooling is not silently erased by a scan.
    new_db = dict(existing_db) if isinstance(existing_db, dict) else {}
    new_db.update({
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "total_courses": len(scanned_courses),
        "menu_schema": MENU_MAP,
        "topic_schema": TOPIC_MAP,
        "courses": scanned_courses
    })

    # ------------------------------------------------------------------ #
    # F1: an empty fetch result must never publish+mirror over data.
    #
    # The old guard was `if fetched_items_count == 0 and existing_courses:`.
    # When the primary catalog was empty-but-valid AND upstream was completely
    # down, `existing_courses` was falsy, the guard was skipped, and the script
    # published an EMPTY catalog and mirrored it over the git-tracked
    # src/data/courses_db.json, exiting 0. Reproduced: primary=0 src=684 ->
    # primary=0 src=0.
    #
    # A publish is now refused whenever the fetch yielded nothing or the result
    # would shrink a non-empty catalog to nothing -- unless the operator passes
    # --allow-empty. Refusal is a failure (exit 1), and the bundled copy is left
    # untouched because it is the recovery source.
    # ------------------------------------------------------------------ #
    existing_count = len(existing_courses)
    published_count = len(scanned_courses)

    if not allow_empty:
        if fetched_items_count == 0:
            log_message(
                f"❌ Scan fetched 0 items across {len(MENU_TARGETS)} categories "
                f"({categories_ok} responded); keeping the existing catalog unchanged. "
                f"（若確定要發佈空白目錄，請使用 --allow-empty）"
            )
            return {
                "total": existing_count,
                "new": 0,
                "updated": 0,
                "error": "scan fetched no items; catalog left unchanged",
            }
        if published_count == 0 and existing_count > 0:
            log_message(
                f"❌ Scan produced 0 courses while the existing catalog holds "
                f"{existing_count}; refusing to publish an empty catalog."
            )
            return {
                "total": existing_count,
                "new": 0,
                "updated": 0,
                "error": "scan produced an empty catalog; refusing to overwrite non-empty data",
            }

    write_json_atomic(DB_PATH, new_db)

    # Sync the bundled copy (used as the recovery source and shipped in the image).
    mc.sync_to_src(new_db)

    log_message(f"✅ Scan finished. Total courses: {len(scanned_courses)} | New: {new_items_count} | Updated: {updated_items_count}")
    return {
        "total": len(scanned_courses),
        "new": new_items_count,
        "updated": updated_items_count,
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    }


def main(argv=None):
    """Takes the shared catalog lock, then runs the scan."""
    args = parse_args(argv)
    try:
        with mc.catalog_lock():
            result = run_scan(allow_empty=args.allow_empty)
    except mc.CatalogBusy as e:
        log_message(f"⏭️ 略過掃描：{e}")
        return mc.EXIT_BUSY

    # A scan that could not produce courses must not report success, otherwise
    # the Node parent logs "Completed successfully" and the UI shows no problem.
    if isinstance(result, dict) and result.get("error"):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
