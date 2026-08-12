#!/usr/bin/env python3
"""
Fayun.org Daily Media Scanner
Scans fayun.org every 24 hours for new courses, audio, video, and PDF notes.
Updates src/data/courses_db.json automatically.
"""

import os
import sys
import json
import time
import urllib.request
from datetime import datetime

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(PROJECT_DIR, "data")
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, "courses_db.json")

# Fallback initialization from src/data/courses_db.json if data/courses_db.json doesn't exist
SRC_DB_PATH = os.path.join(PROJECT_DIR, "src", "data", "courses_db.json")
if not os.path.exists(DB_PATH) and os.path.exists(SRC_DB_PATH):
    try:
        import shutil
        shutil.copyfile(SRC_DB_PATH, DB_PATH)
    except Exception as e:
        print(f"Warning: Could not initialize {DB_PATH}: {e}")
        print(f"Warning: Could not initialize {DB_PATH}: {e}")

LOG_DIR = os.path.join(PROJECT_DIR, "data", "logs")
os.makedirs(LOG_DIR, exist_ok=True)
LOG_PATH = os.path.join(LOG_DIR, "scanner.log")

legacy_logs = [
    os.path.join(PROJECT_DIR, "logs", "scanner.log"),
    os.path.join(PROJECT_DIR, "scanner.log")
]
for old_log in legacy_logs:
    if os.path.exists(old_log) and old_log != LOG_PATH:
        try:
            if not os.path.exists(LOG_PATH):
                import shutil
                shutil.copyfile(old_log, LOG_PATH)
                break
        except:
            pass

DB_ACCESS_URL = "https://www.fayun.org/public/php/dbaccess.php"

MENU_TARGETS = [
    ("dharma", "jing"),
    ("dharma", "lun"),
    ("zen", "zhiguan"),
    ("teaching", "kaishi"),
    ("teaching", "story")
]

MENU_MAP = {
    "dharma": {
        "title": "佛法經論",
        "subs": {
            "jing": "解經（經藏）",
            "lun": "釋論（論藏）"
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
            "story": "佛典故事"
        }
    }
}

TOPIC_MAP = {
    "ahanjing": "阿含經",
    "bashiguijusong": "八識規矩頌",
    "borejing": "般若經藏",
    "chan": "禪修止觀",
    "dabei": "大悲心陀羅尼",
    "daniepanjing": "大般涅槃經",
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
    "others": "其他開示資料",
    "qa": "佛學問答",
    "ruzhonglun": "入中論",
    "shedachenglun": "攝大乘論",
    "story_teller": "佛典與高僧故事",
    "weimojiejing": "維摩詰所說經",
    "xinjing": "般若波羅蜜多心經",
    "yoga": "瑜伽師地論"
}

def log_message(msg):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    formatted = f"[{timestamp}] {msg}"
    print(formatted)
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(formatted + "\n")

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
    }
}

def run_scan():
    log_message("Starting fayun.org media scan...")

    existing_db = {"courses": []}
    if os.path.exists(DB_PATH):
        with open(DB_PATH, "r", encoding="utf-8") as f:
            existing_db = json.load(f)

    existing_courses = {c["id"]: c for c in existing_db.get("courses", [])}
    new_items_count = 0
    updated_items_count = 0

    scanned_courses = []

    for main_menu, sub_menu in MENU_TARGETS:
        try:
            items = fetch_category_media(main_menu, sub_menu)
            for item in items:
                c_id = item.get("id")
                c_name = item.get("name", "").strip()
                topic = item.get("topic") or ""

                main_title = MENU_MAP.get(main_menu, {}).get("title", main_menu)
                sub_title = MENU_MAP.get(main_menu, {}).get("subs", {}).get(sub_menu, sub_menu)
                topic_title = TOPIC_MAP.get(topic, topic) or "通用主題"

                existing = existing_courses.get(c_id)
                c_pdfs = existing.get("pdfs", []) if existing else []

                audio_p = item.get("audio_path")
                lecture_p = item.get("lecture_path_audio") or item.get("lecture_path_video")

                if c_id in PATH_OVERRIDES:
                    if "audio_path" in PATH_OVERRIDES[c_id]:
                        audio_p = PATH_OVERRIDES[c_id]["audio_path"]
                    if "lecture_path" in PATH_OVERRIDES[c_id]:
                        lecture_p = PATH_OVERRIDES[c_id]["lecture_path"]

                course_obj = {
                    "id": c_id,
                    "name": c_name,
                    "main_menu": main_menu,
                    "main_menu_title": main_title,
                    "sub_menu": sub_menu,
                    "sub_menu_title": sub_title,
                    "topic": topic,
                    "topic_title": topic_title,
                    "location": item.get("location") or "美國法雲寺禪學院",
                    "time": item.get("time") or "",
                    "total_episodes": item.get("total", 0) or 0,
                    "audio_path": audio_p,
                    "video_path": item.get("video_path"),
                    "lecture_path": lecture_p,
                    "poster_path": item.get("poster_path"),
                    "comment": item.get("comment"),
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
            log_message(f"❌ Error scanning {main_menu}/{sub_menu}: {e}")

    scanned_courses.sort(key=lambda x: (x["main_menu"], x["sub_menu"], x["topic"], x["name"]))

    new_db = {
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "total_courses": len(scanned_courses),
        "menu_schema": MENU_MAP,
        "topic_schema": TOPIC_MAP,
        "courses": scanned_courses
    }

    with open(DB_PATH, "w", encoding="utf-8") as f:
        json.dump(new_db, f, ensure_ascii=False, indent=2)

    log_message(f"✅ Scan finished. Total courses: {len(scanned_courses)} | New: {new_items_count} | Updated: {updated_items_count}")
    return {
        "total": len(scanned_courses),
        "new": new_items_count,
        "updated": updated_items_count,
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    }

if __name__ == "__main__":
    run_scan()
