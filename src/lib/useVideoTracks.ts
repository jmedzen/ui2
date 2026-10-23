/**
 * Discovers the video lectures (影音講記) for a course.
 *
 * See `useAudioTracks` for why this lives outside the component.
 */

import { useEffect, useRef, useState } from 'react';

import type { CourseItem } from '@/types/course';
import {
  VIDEO_EXTS,
  extractFilename,
  sortVolumes,
  sharedRootDirFor,
  type FileEntry
} from '@/lib/courseMedia';
import type { VideoTrackInfo } from '@/components/VideoPlayer';

export interface VideoTracksState {
  tracks: VideoTrackInfo[];
  isLoading: boolean;
  error: string | null;
}

export function useVideoTracks(course: CourseItem, reloadToken: number): VideoTracksState {
  const [tracks, setTracks] = useState<VideoTrackInfo[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    let isMounted = true;

    async function load() {
  setIsLoading(true);
  setTracks([]);
  setError(null);
  let videoFailed = false;
  // Not `setCurrentVideoIndex`: that setter is declared further down, and
  // resetting the index here only matters once the new list arrives (the
  // clamp handles it). Persisting 0 would also discard the reader's saved
  // position for this course.


  let fetchedVideos: VideoTrackInfo[] = [];
  const vPath = course.video_path || sharedRootDirFor(course);

  if (vPath) {
    try {
      const res = await fetch('/api/list-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ src: vPath }),
        signal: controller.signal
      });
      if (res.ok) {
        const rawData = await res.json();
        const listData = rawData && typeof rawData === 'object' && rawData.data !== undefined ? rawData.data : rawData;

        // Case 1: Standard flat array of video filenames
        if (Array.isArray(listData) && listData.length > 0) {
          const videoFiles = listData
            .map(extractFilename)
            .filter((filename: string) => {
              const ext = '.' + filename.split('.').pop()?.toLowerCase();
              return VIDEO_EXTS.includes(ext);
            })
            .sort((a: string, b: string) =>
              a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
            );

          fetchedVideos = videoFiles.map((filename: string, idx: number) => {
            const fullPath = `${vPath}/${filename}`;
            return {
              index: idx,
              filename: filename,
              displayName: filename,
              url: `https://www.fayun.org/ftpadmin${fullPath}`,
              proxyUrl: `/api/proxy?path=${encodeURIComponent(fullPath)}`
            };
          });
        } else if (listData && typeof listData === 'object') {
          // Case 2: Object response
          // Case 2a: Single folder object { video: [...], audio: [...], bilu: [...] }
          if (Array.isArray(listData.video)) {
            const videoFiles = (listData.video || [])
              .map(extractFilename)
              .filter((filename: string) => {
                const ext = '.' + filename.split('.').pop()?.toLowerCase();
                return VIDEO_EXTS.includes(ext);
              })
              .sort((a: string, b: string) =>
                a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
              );

            fetchedVideos = videoFiles.map((filename: string, idx: number) => {
              const fullPath = `${vPath}/video/${filename}`;
              return {
                index: idx,
                filename: filename,
                displayName: filename,
                url: `https://www.fayun.org/ftpadmin${fullPath}`,
                proxyUrl: `/api/proxy?path=${encodeURIComponent(fullPath)}`
              };
            });
          } else {
            // Case 2b: Multi-volume course (e.g. 瑜伽師地論．本地分 with 51 volumes)
            const sortedVols = sortVolumes(Object.keys(listData));
            const parsedVideoTracks: VideoTrackInfo[] = [];

            sortedVols.forEach((vol) => {
              const vData = listData[vol];
              let videoList: FileEntry[] = [];
              let videoSubfolder = 'video';

              if (Array.isArray(vData)) {
                videoList = vData;
                videoSubfolder = '';
              } else if (vData && typeof vData === 'object') {
                if (Array.isArray(vData.video)) {
                  videoList = vData.video;
                  videoSubfolder = 'video';
                } else {
                  for (const subKey of Object.keys(vData)) {
                    if (Array.isArray(vData[subKey])) {
                      const sample = vData[subKey][0];
                      if (typeof sample === 'string' && VIDEO_EXTS.some((ext: string) => sample.toLowerCase().endsWith(ext))) {
                        videoList = vData[subKey];
                        videoSubfolder = subKey;
                        break;
                      }
                    }
                  }
                }
              }

              const validVideos = videoList
                .map(extractFilename)
                .filter((fn: string) => VIDEO_EXTS.includes('.' + fn.split('.').pop()?.toLowerCase()))
                .sort((a: string, b: string) => {
                  // Natural numeric sort by extracting episode number before extension
                  const baseA = a.substring(0, a.lastIndexOf('.')) || a;
                  const baseB = b.substring(0, b.lastIndexOf('.')) || b;
                  const numsA = baseA.match(/\d+/g);
                  const numsB = baseB.match(/\d+/g);
                  const numA = numsA ? parseInt(numsA[numsA.length - 1], 10) : 99999;
                  const numB = numsB ? parseInt(numsB[numsB.length - 1], 10) : 99999;
                  if (numA !== numB) return numA - numB;
                  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
                });

              validVideos.forEach((fn: string) => {
                const subPath = videoSubfolder ? `${vol}/${videoSubfolder}/${fn}` : `${vol}/${fn}`;
                const fullPath = `${vPath}/${subPath}`;
                parsedVideoTracks.push({
                  index: parsedVideoTracks.length,
                  filename: fn,
                  volume: vol,
                  displayName: `[${vol}] ${fn}`,
                  url: `https://www.fayun.org/ftpadmin${fullPath}`,
                  proxyUrl: `/api/proxy?path=${encodeURIComponent(fullPath)}`
                });
              });
            });

            fetchedVideos = parsedVideoTracks;
          }
        }
      }
    } catch (e: unknown) {
      if (!(e instanceof Error && e.name === 'AbortError')) {
        console.warn('Failed to fetch remote video list:', e);
        videoFailed = true;
      }
    }
  }

  if (isMounted) {
    setTracks(fetchedVideos);
    if (videoFailed && fetchedVideos.length === 0) {
      setError('無法連線至影音清單服務。');
    }
    setIsLoading(false);
  }
    }

    void load();

    return () => {
      mountedRef.current = false;
      isMounted = false;
      controller.abort();
    };
  }, [course, reloadToken]);

  return { tracks, isLoading, error };
}
