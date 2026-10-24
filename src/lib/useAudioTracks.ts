/**
 * Discovers the audio episodes for a course.
 *
 * Extracted from `CourseDetail.tsx`, where this logic shared one effect with the
 * video and PDF loaders and could only be tested by reading the component's
 * source text. The probe deliberately swallows per-path errors so one bad
 * candidate cannot abort the whole search; that is why success and failure are
 * tracked separately from the returned tracks.
 */

import { useEffect, useState } from 'react';

import type { CourseItem } from '@/types/course';
import {
  AUDIO_EXTS,
  extractFilename,
  sortVolumes,
  type AudioTrackInfo,
  type FileEntry
} from '@/lib/courseMedia';

export interface AudioTracksState {
  tracks: AudioTrackInfo[];
  availableVolumes: string[];
  isLoading: boolean;
  error: string | null;
}

export interface AudioDiscoveryResult {
  tracks: AudioTrackInfo[];
  volumes: string[];
  error: string | null;
}

/**
 * Probes the directory listing service for a course's audio episodes.
 *
 * Returns `null` when `signal` was aborted, which callers MUST treat as "this
 * run no longer owns the UI" and discard. That is the fix for a race: the hook
 * used a single shared `mountedRef` that the NEXT effect run immediately set
 * back to true, so a superseded run (the reader had already switched course)
 * still committed its tracks, its "無法連線" error and `isLoading=false` over
 * the new course's in-flight load. Aborted probes also count as failures inside
 * the run, which is exactly what produced the spurious error banner.
 */
export async function discoverAudioTracks(
  course: CourseItem,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<AudioDiscoveryResult | null> {
  // Tracks whether discovery failed, as opposed to genuinely finding nothing.
  // `queryDirectory` deliberately swallows its own errors so one bad
  // candidate path cannot abort the whole probe, which means the caller has
  // no other way to tell "all probes errored" from "all paths were empty".
  let probeAttempts = 0;
  let probeFailures = 0;

  let fetchedTracks: AudioTrackInfo[] = [];
  let detectedVolumes: string[] = [];

  const queryDirectory = async (aPath: string): Promise<{ path: string; tracks: { filename: string; subPath: string; volume?: string }[]; volumes: string[] }> => {
    try {
      const res = await fetchImpl('/api/list-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ src: aPath }),
        signal
      });
      if (!res.ok) {
        probeFailures += 1;
        return { path: aPath, tracks: [], volumes: [] };
      }
      const rawData = await res.json();
      const listData = rawData && typeof rawData === 'object' && rawData.data !== undefined ? rawData.data : rawData;

      // Case 1: Standard flat array of filenames
      if (Array.isArray(listData)) {
        const audioFiles = listData
          .map(extractFilename)
          .filter((filename: string) => {
            const ext = '.' + filename.split('.').pop()?.toLowerCase();
            return AUDIO_EXTS.includes(ext);
          })
          .sort((a: string, b: string) =>
            a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
          );
        return {
          path: aPath,
          tracks: audioFiles.map((fn: string) => ({ filename: fn, subPath: fn })),
          volumes: []
        };
      }

      // Case 2: Object response
      if (listData && typeof listData === 'object') {
        // Case 2a: Single folder object { audio: [...], video: [...], bilu: [...] }
        if (Array.isArray(listData.audio) || Array.isArray(listData.video) || Array.isArray(listData.bilu)) {
          const audios = (listData.audio || [])
            .map(extractFilename)
            .filter((fn: string) => AUDIO_EXTS.includes('.' + fn.split('.').pop()?.toLowerCase()))
            .sort((a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
          return {
            path: aPath,
            tracks: audios.map((fn: string) => ({ filename: fn, subPath: `audio/${fn}` })),
            volumes: []
          };
        }

        // Case 2b: Multi-volume course (e.g. 瑜伽師地論．本地分 with 51 volumes)
        const sortedVols = sortVolumes(Object.keys(listData));
        const parsedTracks: { filename: string; subPath: string; volume?: string }[] = [];

        sortedVols.forEach((vol) => {
          const vData = listData[vol];
          let audioList: FileEntry[] = [];
          let audioSubfolder = 'audio';

          if (Array.isArray(vData)) {
            audioList = vData;
            audioSubfolder = '';
          } else if (vData && typeof vData === 'object') {
            if (Array.isArray(vData.audio)) {
              audioList = vData.audio;
              audioSubfolder = 'audio';
            } else {
              for (const subKey of Object.keys(vData)) {
                if (Array.isArray(vData[subKey])) {
                  const sample = vData[subKey][0];
                  if (typeof sample === 'string' && AUDIO_EXTS.some((ext: string) => sample.toLowerCase().endsWith(ext))) {
                    audioList = vData[subKey];
                    audioSubfolder = subKey;
                    break;
                  }
                }
              }
            }
          }

          const validFiles = audioList
            .map(extractFilename)
            .filter((fn: string) => AUDIO_EXTS.includes('.' + fn.split('.').pop()?.toLowerCase()))
            .sort((a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

          validFiles.forEach((fn: string) => {
            const subPath = audioSubfolder ? `${vol}/${audioSubfolder}/${fn}` : `${vol}/${fn}`;
            parsedTracks.push({
              filename: fn,
              subPath,
              volume: vol
            });
          });
        });

        return {
          path: aPath,
          tracks: parsedTracks,
          volumes: sortedVols
        };
      }

      return { path: aPath, tracks: [], volumes: [] };
    } catch {
      probeFailures += 1;
      return { path: aPath, tracks: [], volumes: [] };
    }
  };

  // 1. Fast-Path: Probe primary course.audio_path first
  if (course.audio_path && course.audio_path !== '/media') {
    probeAttempts += 1;
    const primaryResult = await queryDirectory(course.audio_path);
    if (primaryResult.tracks.length > 0 && !signal.aborted) {
      fetchedTracks = primaryResult.tracks.map((t, idx) => {
        const fullPath = `${primaryResult.path}/${t.subPath}`;
        return {
          index: idx,
          filename: t.filename,
          volume: t.volume,
          displayName: t.volume ? `[${t.volume}] ${t.filename}` : t.filename,
          url: `https://www.fayun.org/ftpadmin${fullPath}`,
          proxyUrl: `/api/proxy?path=${encodeURIComponent(fullPath)}`
        };
      });
      detectedVolumes = primaryResult.volumes;
    }
  }

  // 2. Parallel Candidate Probe if fast-path yielded no tracks
  if (fetchedTracks.length === 0 && !signal.aborted) {
    const potentialAudioPaths: string[] = [];

    // Special rule for 本地分 or any multi-volume yoga course
    if (course.name.includes('本地分')) {
      potentialAudioPaths.push('/media/釋論/瑜伽師地論・本地分');
      potentialAudioPaths.push('/media/釋論/瑜伽師地論.本地分');
      potentialAudioPaths.push('/media/釋論/瑜伽師地論·本地分');
      potentialAudioPaths.push('/media/釋論/瑜伽師地論/本地分');
    }

    if (course.audio_path && course.audio_path !== '/media') {
      const parentDir = course.audio_path.split('/audio')[0];
      const topicDir = parentDir.includes('/') ? parentDir.substring(0, parentDir.lastIndexOf('/')) : '';
      potentialAudioPaths.push(`${parentDir}/${course.name}/audio`);
      potentialAudioPaths.push(`${parentDir}/${course.name}`);
      if (topicDir) {
        potentialAudioPaths.push(`${topicDir}/${course.name}/audio`);
        potentialAudioPaths.push(`${topicDir}/${course.name}`);
      }
    }
    if (course.video_path) potentialAudioPaths.push(course.video_path);

    const uniqueCandidatePaths = Array.from(new Set(potentialAudioPaths)).filter((p) => p !== course.audio_path && p !== '/media');

    if (uniqueCandidatePaths.length > 0) {
      probeAttempts += uniqueCandidatePaths.length;
      const results = await Promise.allSettled(uniqueCandidatePaths.map(queryDirectory));

      for (const res of results) {
        if (res.status === 'fulfilled' && res.value.tracks.length > 0) {
          fetchedTracks = res.value.tracks.map((t, idx) => {
            const fullPath = `${res.value.path}/${t.subPath}`;
            return {
              index: idx,
              filename: t.filename,
              volume: t.volume,
              displayName: t.volume ? `[${t.volume}] ${t.filename}` : t.filename,
              url: `https://www.fayun.org/ftpadmin${fullPath}`,
              proxyUrl: `/api/proxy?path=${encodeURIComponent(fullPath)}`
            };
          });
          detectedVolumes = res.value.volumes;
          break;
        }
      }
    }
  }

  if (signal.aborted) return null;

  // Only when nothing was found AND every probe errored: a partial success
  // means the empty state is the honest answer.
  const error =
    fetchedTracks.length === 0 && probeAttempts > 0 && probeFailures === probeAttempts
      ? '無法連線至音訊清單服務。'
      : null;
  return { tracks: fetchedTracks, volumes: detectedVolumes, error };
}

/**
 * @param course   Course whose audio is being discovered.
 * @param reloadToken Bumped by the reader's retry button to re-run discovery.
 */
export function useAudioTracks(course: CourseItem, reloadToken: number): AudioTracksState {
  const [tracks, setTracks] = useState<AudioTrackInfo[]>([]);
  const [availableVolumes, setAvailableVolumes] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // One controller PER RUN. Its signal is the only ownership test: a shared
    // ref is reset by the next run and cannot tell runs apart.
    const controller = new AbortController();

    async function load() {
      setIsLoading(true);
      setTracks([]);
      setAvailableVolumes([]);
      setError(null);

      const result = await discoverAudioTracks(course, controller.signal);
      if (!result || controller.signal.aborted) return;

      setTracks(result.tracks);
      setAvailableVolumes(result.volumes);
      setError(result.error);
      setIsLoading(false);
    }

    void load();

    return () => {
      controller.abort();
    };
  }, [course, reloadToken]);

  return { tracks, availableVolumes, isLoading, error };
}
