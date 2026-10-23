/**
 * Discovers the lecture-note PDFs (講義) for a course.
 *
 * See `useAudioTracks` for why this lives outside the component.
 */

import { useEffect, useState } from 'react';

import type { CourseItem, PdfItem } from '@/types/course';
import {
  canonicalPdfPath,
  extractFilename,
  sharedRootDirFor,
  sortVolumes,
  type FileEntry
} from '@/lib/courseMedia';

export interface PdfTracksState {
  tracks: PdfItem[];
  isLoading: boolean;
  error: string | null;
}

export function usePdfTracks(course: CourseItem, reloadToken: number): PdfTracksState {
  // Seeded from the catalog so the tab has something to show before discovery
  // finishes; the effect below replaces it once the remote listing arrives.
  const [tracks, setTracks] = useState<PdfItem[]>(
    () => (course.pdfs || []).filter((p) => !p.filename.endsWith('_筆記.pdf'))
  );
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let isMounted = true;

    async function load() {
  setIsLoading(true);
  setError(null);
  let pdfFailed = false;
  const initialPdfs = (course.pdfs || []).filter(p => !p.filename.endsWith('_筆記.pdf'));
  setTracks(initialPdfs);

  const potentialPaths: string[] = [];
  // `lecture_path` is declared on CourseItem and present on 603 rows.
  // A `pdf_path` cast used to be pushed here too, but the field exists on
  // zero rows and is not part of the type, so it was always a dead branch.
  if (course.lecture_path) potentialPaths.push(course.lecture_path);

  if (course.name.includes('本地分')) {
    // Scope to this course's own volume. Pushing the shared root here made
    // every volume page enumerate the whole 503-PDF tree under other
    // volumes' labels (see sharedRootDirFor).
    const scoped = sharedRootDirFor(course) || '/media/釋論/瑜伽師地論・本地分';
    potentialPaths.push(scoped);
  }

  if (course.audio_path && course.audio_path !== '/media') {
    potentialPaths.push(course.audio_path);
    const parentDir = course.audio_path.replace(/\/audio\/?$/, '');
    if (parentDir && parentDir !== course.audio_path) {
      potentialPaths.push(`${parentDir}/bilu`);
      potentialPaths.push(`${parentDir}/pdf`);
      potentialPaths.push(`${parentDir}/beizhu`);
      potentialPaths.push(parentDir);
    }
  }

  if (course.video_path) {
    potentialPaths.push(course.video_path);
    const parentDir = course.video_path.replace(/\/video\/?$/, '');
    if (parentDir && parentDir !== course.video_path) {
      potentialPaths.push(`${parentDir}/bilu`);
      potentialPaths.push(`${parentDir}/pdf`);
      potentialPaths.push(`${parentDir}/beizhu`);
      potentialPaths.push(parentDir);
    }
  }

  const uniquePaths = Array.from(new Set(potentialPaths)).filter((p) => p !== '/media');
  const discoveredPdfs: PdfItem[] = [];
  // One physical file can be discovered through several probed directories,
  // so dedupe on the file identity rather than the full URL.
  const seenPdfKeys = new Set<string>();

  try {
    const results = await Promise.allSettled(
      uniquePaths.map(async (dirPath) => {
        const res = await fetch('/api/list-files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ src: dirPath }),
          signal: controller.signal
        });
        if (!res.ok) return [];
        const rawData = await res.json();
        const listData = Array.isArray(rawData) ? rawData : (rawData && typeof rawData === 'object' ? (rawData.data || rawData) : []);
        const pdfFilenames: { name: string; displayName?: string; folder: string }[] = [];

        if (Array.isArray(listData)) {
          listData.forEach((item: FileEntry) => {
            const fname = extractFilename(item);
            if (fname.toLowerCase().endsWith('.pdf')) {
              pdfFilenames.push({ name: fname, folder: dirPath });
            }
          });
        } else if (listData && typeof listData === 'object') {
          // The upstream returns a single-folder object whose keys are the
          // sub-directories, e.g. { video: [...], bilu: [...] }. Some
          // responses instead use volume names as keys, each holding its own
          // { video, bilu } object.
          //
          // `bilu` / `pdf` / `beizhu` must NOT be treated as volume names:
          // doing so matched the same files twice (once as "volume" `bilu`,
          // once as the media key) and produced duplicate dropdown entries
          // with different URLs for one file.
          const MEDIA_KEYS = ['bilu', 'pdf', 'beizhu'];
          const isMediaKeyObject = (v: unknown): boolean =>
            !!v && typeof v === 'object' && !Array.isArray(v) &&
            Object.keys(v as Record<string, unknown>).length > 0 &&
            Object.keys(v as Record<string, unknown>).every((k) => MEDIA_KEYS.includes(k));

          const allKeys = Object.keys(listData);
          const mediaKeyNames = allKeys.filter((k) => MEDIA_KEYS.includes(k));
          const volumeKeys = allKeys.filter((k) => !MEDIA_KEYS.includes(k));

          // Case 1: multi-volume structure. Only treat a key as a volume
          // when it looks like one (an object that is not a media-key bag).
          sortVolumes(volumeKeys).forEach((vol) => {
            const val = listData[vol];
            if (val && typeof val === 'object' && !isMediaKeyObject(val)) {
              const pdfList = Array.isArray(val)
                ? val
                : (Array.isArray(val.bilu) ? val.bilu : (Array.isArray(val.pdf) ? val.pdf : []));
              pdfList.forEach((item: FileEntry) => {
                const fname = extractFilename(item);
                if (fname.toLowerCase().endsWith('.pdf')) {
                  pdfFilenames.push({
                    name: fname,
                    displayName: `[${vol}] ${fname}`,
                    folder: `${dirPath}/${vol}/bilu`
                  });
                }
              });
            }
          });

          // Case 2: media keys of this folder. Only when the response is not
          // a volume-keyed object, so the two cases never both fire.
          if (mediaKeyNames.length > 0 && volumeKeys.every((k) => !isMediaKeyObject(listData[k]))) {
            mediaKeyNames.forEach((key) => {
              const val = listData[key];
              if (Array.isArray(val)) {
                val.forEach((item: FileEntry) => {
                  const fname = extractFilename(item);
                  if (fname.toLowerCase().endsWith('.pdf')) {
                    pdfFilenames.push({ name: fname, folder: `${dirPath}/${key}` });
                  }
                });
              } else if (val && typeof val === 'object') {
                Object.entries(val).forEach(([subKey, subVal]) => {
                  if (Array.isArray(subVal)) {
                    subVal.forEach((item: FileEntry) => {
                      const fname = extractFilename(item);
                      if (fname.toLowerCase().endsWith('.pdf')) {
                        pdfFilenames.push({ name: fname, folder: `${dirPath}/${key}/${subKey}` });
                      }
                    });
                  }
                });
              }
            });
          }
        }
        return pdfFilenames;
      })
    );

    results.forEach((res) => {
      if (res.status === 'fulfilled' && Array.isArray(res.value)) {
        res.value.forEach((pf) => {
          const pdfUrl = `https://www.fayun.org/ftpadmin${pf.folder}/${pf.name}`;
          // Dedupe on the canonical file identity, not the full URL. The
          // same lecture notes can be reached through several probed
          // directories (e.g. ".../bilu" and its parent, or a volume key that
          // was mistaken for a folder), which yields different URLs for one
          // physical file and previously produced duplicate entries.
          const dedupeKey = canonicalPdfPath(pf.folder, pf.name);
          if (seenPdfKeys.has(dedupeKey)) return;
          seenPdfKeys.add(dedupeKey);
          discoveredPdfs.push({
            num: discoveredPdfs.length + 1,
            filename: pf.displayName || pf.name,
            url: pdfUrl
          });
        });
      }
    });
  } catch (e: unknown) {
    if (!(e instanceof Error && e.name === 'AbortError')) {
      console.warn('Failed to fetch remote PDF list:', e);
      pdfFailed = true;
    }
  }

  discoveredPdfs.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true, sensitivity: 'base' }));
  discoveredPdfs.forEach((p, i) => { p.num = i + 1; });

  if (isMounted) {
    if (discoveredPdfs.length > 0) {
      setTracks(discoveredPdfs);
    } else {
      const fallbackPdfs = (course.pdfs || []).filter(p => !p.filename.endsWith('_筆記.pdf'));
      setTracks(fallbackPdfs);
      // Discovery errored and the bundled catalog has no PDFs either, so the
      // empty state would be reporting a failure as an absence.
      if (pdfFailed && fallbackPdfs.length === 0) {
        setError('無法連線至講義清單服務。');
      }
    }
    setIsLoading(false);
  }
    }

    void load();

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [course, reloadToken]);

  return { tracks, isLoading, error };
}
