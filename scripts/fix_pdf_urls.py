#!/usr/bin/env python3
"""
Scans all courses in src/data/courses_db.json and resolves working PDF URLs from fayun.org
"""

import os
import json
import urllib.request

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(PROJECT_DIR, "src", "data", "courses_db.json")

def get_real_pdfs_for_course(audio_path, video_path, lecture_path):
    potential_paths = []
    if lecture_path:
        potential_paths.append(lecture_path)
    if audio_path:
        parent = audio_path.split('/audio')[0]
        potential_paths.extend([parent, parent + '/bilu', parent + '/beizhu'])
    if video_path:
        parent = video_path.split('/video')[0]
        potential_paths.extend([parent, parent + '/bilu', parent + '/beizhu'])

    unique_paths = list(dict.fromkeys(potential_paths))
    found_pdfs = []

    for dir_path in unique_paths:
        req = urllib.request.Request(
            'https://www.fayun.org/public/php/list.php',
            data=json.dumps({'src': dir_path}).encode('utf-8'),
            headers={'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0'}
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                res = json.loads(resp.read().decode('utf-8'))
                data = res.get('data') if isinstance(res, dict) else res

                files_with_subfolder = []
                if isinstance(data, list):
                    for item in data:
                        fname = item if isinstance(item, str) else item.get('name', '')
                        if fname.endswith('.pdf'):
                            files_with_subfolder.append((fname, dir_path))
                elif isinstance(data, dict):
                    for k, list_val in data.items():
                        if isinstance(list_val, list):
                            sub = f'{dir_path}/{k}' if k in ['bilu', 'beizhu'] else dir_path
                            for item in list_val:
                                fname = item if isinstance(item, str) else item.get('name', '')
                                if fname.endswith('.pdf'):
                                    files_with_subfolder.append((fname, sub))

                for fname, sub in files_with_subfolder:
                    url = f'https://www.fayun.org/ftpadmin{sub}/{fname}'
                    if not any(x['url'] == url for x in found_pdfs):
                        found_pdfs.append({'num': len(found_pdfs) + 1, 'filename': fname, 'url': url})
        except Exception as e:
            pass

    return found_pdfs

def main():
    if not os.path.exists(DB_PATH):
        print("Database file not found.")
        return

    with open(DB_PATH, "r", encoding="utf-8") as f:
        db = json.load(f)

    courses = db.get("courses", [])
    updated_count = 0

    print(f"Scanning {len(courses)} courses for real PDF URLs...")

    for i, c in enumerate(courses):
        audio_path = c.get("audio_path")
        video_path = c.get("video_path")
        lecture_path = c.get("lecture_path")

        real_pdfs = get_real_pdfs_for_course(audio_path, video_path, lecture_path)
        if real_pdfs:
            c["pdfs"] = real_pdfs
            updated_count += 1
            print(f"[{i+1}/{len(courses)}] Updated '{c['name']}': {len(real_pdfs)} PDFs found ({real_pdfs[0]['filename']})")
        else:
            # If no remote pdfs found, keep valid pdfs or clear fake ones
            valid_pdfs = [p for p in c.get("pdfs", []) if "筆記.pdf" not in p.get("filename", "") or p.get("url", "").startswith("https://www.fayun.org/ftpadmin")]
            c["pdfs"] = valid_pdfs

    db["courses"] = courses
    with open(DB_PATH, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=2)

    print(f"Done! Updated PDF entries for {updated_count} courses.")

if __name__ == "__main__":
    main()
