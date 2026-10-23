/**
 * Pure helpers for course media discovery.
 *
 * These were embedded in `CourseDetail.tsx`, a 1,500-line client component, so
 * the only way to test them was to read the component's source text and
 * regex-extract the helper. They have no React or DOM dependency, so they live
 * here and can be imported directly.
 */

import type { CourseItem } from '@/types/course';

/** Episodes rendered per batch. */
export const EPISODE_BATCH_SIZE = 100;

export const AUDIO_EXTS = ['.mp3', '.m4a', '.aac', '.ogg', '.wav', '.wma', '.flac', '.mp4', '.m4v', '.webm', '.mov'];
export const VIDEO_EXTS = ['.mp4', '.m4v', '.wmv', '.flv', '.mov', '.avi', '.mkv', '.webm', '.mpg', '.mpeg'];

export interface AudioTrackInfo {
  filename: string;
  proxyUrl: string;
  url: string;
  index: number;
  volume?: string;
  displayName?: string;
}

/**
 * A file as returned by the upstream directory-listing endpoint: either a bare
 * filename or a `{ name }` record. The endpoint is external, so this is the only
 * shape trusted about it.
 */
export type FileEntry = string | { name?: unknown };

export const extractFilename = (item: FileEntry): string => {
  if (typeof item === 'string') return item;
  if (item && typeof item.name === 'string') return item.name;
  return String(item || '');
};

export const sortVolumes = (vols: string[]): string[] => {
  return [...vols].sort((a, b) => {
    const isSpecialA = /初發|序|概說/.test(a);
    const isSpecialB = /初發|序|概說/.test(b);
    if (isSpecialA && !isSpecialB) return -1;
    if (!isSpecialA && isSpecialB) return 1;

    const getNum = (str: string) => {
      if (str.includes('13-2')) return 13.5;
      const m = str.match(/\d+/);
      return m ? parseFloat(m[0]) : 9999;
    };

    const numA = getNum(a);
    const numB = getNum(b);
    if (numA !== numB) return numA - numB;
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  });
};

/**
 * Builds a canonical identity for a discovered PDF.
 *
 * The same physical file can be surfaced through more than one probed
 * directory, so a naive `folder/name` comparison sees `.../bilu/1.pdf` from
 * `.../bilu` and from `.../bilu/bilu/1.pdf` as two different documents. This
 * collapses repeated trailing directory segments and normalises the filename
 * so the app lists each lecture note exactly once.
 */
export const canonicalPdfPath = (folder: string, name: string): string => {
  const decode = (v: string) => {
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  };
  const decodedName = decode(String(name || '')).trim().replace(/\s+/g, ' ');

  // Collapse consecutive duplicate path segments: /a/bilu/bilu -> /a/bilu
  const segments: string[] = [];
  for (const raw of decode(String(folder || '')).split('/')) {
    const seg = raw.trim();
    if (!seg) continue;
    if (segments.length > 0 && segments[segments.length - 1] === seg) continue;
    segments.push(seg);
  }

  return `${segments.join('/')}::${decodedName}`;
};

/**
 * Derives the shared volume root for a course that has no `video_path`.
 *
 * Multi-volume courses (瑜伽師地論．本地分_卷NN) previously fell back to the whole
 * shared root `/media/釋論/瑜伽師地論・本地分`, so opening one volume listed all
 * ~503 PDFs / 167 videos under every other volume's labels, with URLs
 * synthesised into folders the file was never found in (verified: course 163
 * holds 8 catalog PDFs but discovered 503).
 *
 * The catalog already records each volume's own directory in its PDF URLs
 * (e.g. `.../本地分/卷14/bilu/T163b.pdf`), so the probe can be scoped to that
 * volume. Only the true root course — the one whose name carries no volume
 * suffix and which is already configured with the root as its video_path — has
 * a legitimate reason to enumerate the entire tree.
 */
export const sharedRootDirFor = (course: CourseItem): string | undefined => {
  const name = String(course?.name || '');
  if (!name.includes('本地分')) return undefined;

  // The course NAME is the authoritative volume identifier, so decide from it
  // first. The catalog's PDF URLs were tried first and mis-scoped the true root
  // course (id 97, which legitimately owns all 503 PDFs) to whichever
  // sub-folder happened to appear first — in its case `初發論端`.
  //
  // The volume token must be captured in full: `卷12至13-1` is a real directory
  // name (course id 124), so matching only the leading digits would probe the
  // non-existent `卷12` and return nothing.
  const vols = name.match(/卷[0-9０-９]+(?:[至\-–~][0-9０-９]+)*(?:-[0-9０-９]+)?/g);

  // Exactly one volume marker: scope to that volume.
  if (vols && vols.length === 1) {
    return `/media/釋論/瑜伽師地論・本地分/${vols[0]}`;
  }

  // No volume marker: this is the root course, so its own whole tree is correct.
  if (!/卷/.test(name)) {
    return '/media/釋論/瑜伽師地論・本地分';
  }

  // Ambiguous (several volume markers, e.g. "卷12至13-1"): probing any single
  // volume would mis-attribute files, so fall back to the directory implied by
  // this course's own catalog PDFs and otherwise probe nothing.
  const pdfs = Array.isArray(course?.pdfs) ? course.pdfs : [];
  for (const p of pdfs) {
    const m = String(p?.url || '').match(/ftpadmin(\/media\/[^?]*?)\/(?:bilu|pdf|beizhu|video)\/[^/]+$/);
    if (m) return m[1];
  }
  return undefined;
};
