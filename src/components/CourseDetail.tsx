'use client';

import React, { useState, useEffect, useRef } from 'react';
import { CourseItem, PdfItem } from '@/types/course';
import { useAudio } from '@/context/AudioContext';
import VideoPlayer, { VideoTrackInfo } from './VideoPlayer';
import PdfViewer from './PdfViewer';

interface CourseDetailProps {
  course: CourseItem;
  isZenMode?: boolean;
  onToggleZenMode?: () => void;
  onGoHome?: () => void;
}

const AUDIO_EXTS = ['.mp3', '.m4a', '.aac', '.ogg', '.wav', '.wma', '.flac', '.mp4', '.m4v', '.webm', '.mov'];
const VIDEO_EXTS = ['.mp4', '.m4v', '.wmv', '.flv', '.mov', '.avi', '.mkv', '.webm', '.mpg', '.mpeg'];

export interface AudioTrackInfo {
  filename: string;
  proxyUrl: string;
  url: string;
  index: number;
  volume?: string;
  displayName?: string;
}

const sortVolumes = (vols: string[]): string[] => {
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

const extractFilename = (item: any): string => {
  if (typeof item === 'string') return item;
  if (item && typeof item.name === 'string') return item.name;
  return String(item || '');
};

export default function CourseDetail({ course, isZenMode, onToggleZenMode, onGoHome }: CourseDetailProps) {
  const { currentTrack, isPlaying, playTrack, togglePlay } = useAudio();

  const [activeTab, setActiveTab] = useState<'audio' | 'video' | 'pdf' | 'info' | 'split'>('audio');
  const [audioTracks, setAudioTracks] = useState<AudioTrackInfo[]>([]);
  const [availableVolumes, setAvailableVolumes] = useState<string[]>([]);
  const [selectedVolume, setSelectedVolume] = useState<string>('all');
  const [videoTracks, setVideoTracks] = useState<VideoTrackInfo[]>([]);
  const [pdfTracks, setPdfTracks] = useState<PdfItem[]>(course.pdfs || []);
  const [currentVideoIndex, setCurrentVideoIndex] = useState<number>(0);
  const [isLoadingAudio, setIsLoadingAudio] = useState<boolean>(false);
  const [isLoadingVideo, setIsLoadingVideo] = useState<boolean>(false);
  const [isLoadingPdf, setIsLoadingPdf] = useState<boolean>(false);
  const [episodeSearch, setEpisodeSearch] = useState<string>('');

  // Draggable Split-Screen Ratio
  const [splitRatio, setSplitRatio] = useState<number>(50);
  const splitContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try {
      const savedRatio = localStorage.getItem('fayun_split_ratio');
      if (savedRatio) {
        const val = parseFloat(savedRatio);
        if (!isNaN(val) && val >= 25 && val <= 75) setSplitRatio(val);
      }
    } catch {}
  }, []);

  const handleSplitMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const container = splitContainerRef.current;
    if (!container) return;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const newRatio = Math.max(25, Math.min(75, ((moveEvent.clientX - rect.left) / rect.width) * 100));
      setSplitRatio(newRatio);
      try {
        localStorage.setItem('fayun_split_ratio', String(newRatio.toFixed(1)));
      } catch {}
    };

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();

    async function loadAudioTracks() {
      setIsLoadingAudio(true);
      setAudioTracks([]);
      setAvailableVolumes([]);

      let fetchedTracks: AudioTrackInfo[] = [];
      let detectedVolumes: string[] = [];

      const queryDirectory = async (aPath: string): Promise<{ path: string; tracks: { filename: string; subPath: string; volume?: string }[]; volumes: string[] }> => {
        try {
          const res = await fetch('/api/list-files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ src: aPath }),
            signal: controller.signal
          });
          if (!res.ok) return { path: aPath, tracks: [], volumes: [] };
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
              let audioList: any[] = [];
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
          return { path: aPath, tracks: [], volumes: [] };
        }
      };

      // 1. Fast-Path: Probe primary course.audio_path first
      if (course.audio_path && course.audio_path !== '/media') {
        const primaryResult = await queryDirectory(course.audio_path);
        if (primaryResult.tracks.length > 0 && isMounted) {
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
      if (fetchedTracks.length === 0 && isMounted) {
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

      if (isMounted) {
        setAudioTracks(fetchedTracks);
        setAvailableVolumes(detectedVolumes);
        setIsLoadingAudio(false);
      }
    }

    async function loadVideoTracks() {
      setIsLoadingVideo(true);
      setVideoTracks([]);
      setCurrentVideoIndex(0);

      let fetchedVideos: VideoTrackInfo[] = [];
      const vPath = course.video_path || (course.name.includes('本地分') ? '/media/釋論/瑜伽師地論・本地分' : undefined);

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
                  let videoList: any[] = [];
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
        } catch (e: any) {
          if (e.name !== 'AbortError') {
            console.warn('Failed to fetch remote video list:', e);
          }
        }
      }

      if (isMounted) {
        setVideoTracks(fetchedVideos);
        setIsLoadingVideo(false);
      }
    }

    async function loadPdfTracks() {
      setIsLoadingPdf(true);
      const initialPdfs = (course.pdfs || []).filter(p => !p.filename.endsWith('_筆記.pdf'));
      setPdfTracks(initialPdfs);

      const potentialPaths: string[] = [];
      if ((course as any).lecture_path) potentialPaths.push((course as any).lecture_path);
      if ((course as any).pdf_path) potentialPaths.push((course as any).pdf_path);

      if (course.name.includes('本地分')) {
        potentialPaths.push('/media/釋論/瑜伽師地論・本地分');
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
              listData.forEach((item: any) => {
                const fname = extractFilename(item);
                if (fname.toLowerCase().endsWith('.pdf')) {
                  pdfFilenames.push({ name: fname, folder: dirPath });
                }
              });
            } else if (listData && typeof listData === 'object') {
              // Case 1: Multi-volume structure
              const volKeys = sortVolumes(Object.keys(listData));
              volKeys.forEach((vol) => {
                const val = listData[vol];
                if (val && typeof val === 'object') {
                  const pdfList = Array.isArray(val)
                    ? val
                    : (Array.isArray(val.bilu) ? val.bilu : (Array.isArray(val.pdf) ? val.pdf : []));
                  pdfList.forEach((item: any) => {
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

              // Case 2: Single folder object with bilu/pdf/beizhu keys
              ['bilu', 'pdf', 'beizhu'].forEach((key) => {
                const val = listData[key];
                if (Array.isArray(val)) {
                  val.forEach((item: any) => {
                    const fname = extractFilename(item);
                    if (fname.toLowerCase().endsWith('.pdf')) {
                      pdfFilenames.push({ name: fname, folder: `${dirPath}/${key}` });
                    }
                  });
                }
              });
            }
            return pdfFilenames;
          })
        );

        results.forEach((res) => {
          if (res.status === 'fulfilled' && Array.isArray(res.value)) {
            res.value.forEach((pf) => {
              const pdfUrl = `https://www.fayun.org/ftpadmin${pf.folder}/${pf.name}`;
              if (!discoveredPdfs.some((p) => p.url === pdfUrl)) {
                discoveredPdfs.push({
                  num: discoveredPdfs.length + 1,
                  filename: pf.displayName || pf.name,
                  url: pdfUrl
                });
              }
            });
          }
        });
      } catch (e: any) {
        if (e.name !== 'AbortError') {
          console.warn('Failed to fetch remote PDF list:', e);
        }
      }

      discoveredPdfs.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true, sensitivity: 'base' }));
      discoveredPdfs.forEach((p, i) => { p.num = i + 1; });

      if (isMounted) {
        if (discoveredPdfs.length > 0) {
          setPdfTracks(discoveredPdfs);
        } else {
          const fallbackPdfs = (course.pdfs || []).filter(p => !p.filename.endsWith('_筆記.pdf'));
          setPdfTracks(fallbackPdfs);
        }
        setIsLoadingPdf(false);
      }
    }

    loadAudioTracks();
    loadVideoTracks();
    loadPdfTracks();

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [course]);

  const hasVideo = Boolean(course.video_path || (course.name && course.name.includes('本地分')));

  // Restore saved active tab & video index per course on mount/course change
  useEffect(() => {
    try {
      const savedTab = localStorage.getItem(`fayun_last_tab_${course.id}`);
      if (savedTab && ['audio', 'video', 'pdf', 'info', 'split'].includes(savedTab)) {
        if ((savedTab === 'video' || savedTab === 'split') && !hasVideo) {
          setActiveTab('audio');
        } else {
          setActiveTab(savedTab as any);
        }
      } else {
        setActiveTab('audio');
      }

      const savedVideoIdx = localStorage.getItem(`fayun_last_video_idx_${course.id}`);
      if (savedVideoIdx) {
        const parsed = parseInt(savedVideoIdx, 10);
        if (!isNaN(parsed) && parsed >= 0) {
          setCurrentVideoIndex(parsed);
        } else {
          setCurrentVideoIndex(0);
        }
      } else {
        setCurrentVideoIndex(0);
      }
    } catch (e) {
      console.warn('Failed to restore course tab state:', e);
    }
  }, [course.id, course.video_path, hasVideo]);

  const handleTabClick = (tab: 'audio' | 'video' | 'pdf' | 'info' | 'split') => {
    if ((tab === 'video' || tab === 'split') && !hasVideo) {
      return;
    }
    if (tab === 'video' && isPlaying) {
      togglePlay();
    }
    setActiveTab(tab);
    try {
      localStorage.setItem(`fayun_last_tab_${course.id}`, tab);
    } catch {}
  };

  const handleVideoSelect = (idx: number) => {
    if (idx >= 0 && idx < videoTracks.length) {
      setCurrentVideoIndex(idx);
      if (isPlaying) {
        togglePlay();
      }
      try {
        localStorage.setItem(`fayun_last_video_idx_${course.id}`, String(idx));
      } catch {}
    }
  };

  useEffect(() => {
    setSelectedVolume('all');
    setAvailableVolumes([]);
    setEpisodeSearch('');
  }, [course.id]);

  const filteredAudioTracks = audioTracks.filter((t) => {
    const matchVol = selectedVolume === 'all' || t.volume === selectedVolume;
    const q = episodeSearch.trim().toLowerCase();
    const matchSearch = q
      ? (t.filename.toLowerCase().includes(q) ||
         (t.displayName && t.displayName.toLowerCase().includes(q)) ||
         (t.volume && t.volume.toLowerCase().includes(q)))
      : true;
    return matchVol && matchSearch;
  });

  return (
    <div className="course-detail-pane">
      {/* Course Top Title & Information Card */}
      <div className="shadow-card">
        <div className="course-header-top-row">
          <div className="breadcrumb">
            <span
              className="breadcrumb-home"
              onClick={onGoHome}
              role="button"
              tabIndex={0}
              title="點擊回到法雲資訊網首頁"
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onGoHome?.();
                }
              }}
            >
              法雲資訊網
            </span>
            <span>/</span>
            <span>{course.main_menu_title}</span>
            <span>/</span>
            <span>{course.sub_menu_title}</span>
            <span>/</span>
            <span className="current">{course.name}</span>
          </div>

          {onToggleZenMode && (
            <button
              className={`zen-focus-toggle-btn ${isZenMode ? 'active' : ''}`}
              onClick={onToggleZenMode}
              title={isZenMode ? '退出禪境專注模式 (Esc)' : '一鍵開啟禪境專注模式 (全螢幕研經聽法)'}
            >
              {isZenMode ? '✕ 退出專注 (Esc)' : '⛶ 禪境專注'}
            </button>
          )}
        </div>

        <h1 className="course-title">{course.name}</h1>

        <div className="course-meta-tags">
          <span className="meta-tag teacher">主講：玅境長老</span>
          <span className="meta-tag venue">地點：{course.location || '法雲寺'}</span>
          <span className="meta-tag time">日期：{course.time || '典藏'}</span>
          <span className="meta-tag episodes">音訊集數：{course.total_episodes || audioTracks.length} 集</span>
          {hasVideo && (
            <span className="meta-tag video-badge-tag">🎥 影音講記檔</span>
          )}
          {course.pdfs && course.pdfs.length > 0 && (
            <span className="meta-tag pdf-badge">📄 包含 {course.pdfs.length} 份 PDF 筆記講義</span>
          )}
        </div>
      </div>

      {/* Primary Content Area: Tabs + Display Panes */}
      <div className="shadow-card content-card">
        <div className="tab-navigation">
          <button
            className={`tab-btn ${activeTab === 'audio' ? 'active' : ''}`}
            onClick={() => handleTabClick('audio')}
          >
            🎵 音訊錄音 ({audioTracks.length || course.total_episodes || 0})
          </button>
          {hasVideo && (
            <button
              className={`tab-btn ${activeTab === 'video' ? 'active' : ''}`}
              onClick={() => handleTabClick('video')}
            >
              🎬 影音講記 ({videoTracks.length || '載入中'})
            </button>
          )}
          <button
            className={`tab-btn ${activeTab === 'pdf' ? 'active' : ''}`}
            onClick={() => handleTabClick('pdf')}
          >
            📄 筆記講義 ({pdfTracks.length})
          </button>
          {hasVideo && pdfTracks.length > 0 && (
            <button
              className={`tab-btn split-btn ${activeTab === 'split' ? 'active' : ''}`}
              onClick={() => handleTabClick('split')}
            >
              📺 影音+講義雙欄對照
            </button>
          )}
          <button
            className={`tab-btn ${activeTab === 'info' ? 'active' : ''}`}
            onClick={() => handleTabClick('info')}
          >
            ℹ️ 典藏資訊
          </button>
        </div>

        <div className="tab-content-pane">
          {/* 1. Audio Track List Tab */}
          {activeTab === 'audio' && (
            <div className="audio-tab-content">
              <div className="track-list-toolbar">
                <div className="toolbar-search-wrapper">
                  <input
                    type="text"
                    placeholder="🔍 搜尋單集檔名、卷次或集數..."
                    value={episodeSearch}
                    onChange={(e) => setEpisodeSearch(e.target.value)}
                    className="episode-search-input"
                  />
                  {episodeSearch && (
                    <button
                      className="search-clear-btn"
                      onClick={() => setEpisodeSearch('')}
                      title="清除搜尋"
                    >
                      ✕
                    </button>
                  )}
                </div>

                {availableVolumes.length > 1 && (
                  <div className="toolbar-volume-selector">
                    <span className="volume-select-label">📑 卷次導覽：</span>
                    <select
                      value={selectedVolume}
                      onChange={(e) => setSelectedVolume(e.target.value)}
                      className="volume-dropdown"
                    >
                      <option value="all">全部卷次（共 {audioTracks.length} 講）</option>
                      {availableVolumes.map((vol) => {
                        const count = audioTracks.filter((t) => t.volume === vol).length;
                        return (
                          <option key={vol} value={vol}>
                            {vol}（{count} 講）
                          </option>
                        );
                      })}
                    </select>
                  </div>
                )}

                <span className="track-count-info">
                  顯示 {filteredAudioTracks.length} / {audioTracks.length} 集
                </span>
              </div>

              {isLoadingAudio ? (
                <div className="loading-state">
                  <span className="loading-spinner">🌸</span>
                  <p>正在載入音訊清單...</p>
                </div>
              ) : audioTracks.length === 0 ? (
                <div className="no-audio-state">
                  <p>尚無線上記錄之音訊檔案，或正在數據庫同步中</p>
                </div>
              ) : (
                <ul className="episodes-list">
                  {filteredAudioTracks.map((track) => {
                    const isCurrentlyPlayingTrack =
                      currentTrack?.courseId === course.id && currentTrack?.filename === (track.displayName || track.filename);

                    return (
                      <li
                        key={track.index}
                        className={`episode-item ${isCurrentlyPlayingTrack ? 'playing' : ''}`}
                        onClick={() => playTrack(course.name, course.id, audioTracks.map(t => ({
                          filename: t.displayName || t.filename,
                          url: t.url,
                          proxyUrl: t.proxyUrl,
                          index: t.index
                        })), track.index)}
                      >
                        <span className="episode-index">{track.index + 1}</span>
                        <div className="episode-info">
                          {track.volume && (
                            <span className="track-volume-pill">{track.volume}</span>
                          )}
                          <span className="episode-name">{track.filename}</span>
                        </div>
                        <div className="episode-actions">
                          {isCurrentlyPlayingTrack ? (
                            <span className="now-playing-label">
                              {isPlaying ? '▶ 播放中' : '⏸ 暫停中'}
                            </span>
                          ) : (
                            <button className="play-track-btn">▶ 播放</button>
                          )}
                          <a
                            href={track.proxyUrl}
                            download={track.filename}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="download-track-link"
                            title="下載 MP3/M4A 音訊"
                          >
                            ⬇ 下載
                          </a>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {/* 2. Video Player Tab */}
          {activeTab === 'video' && (
            <div className="video-tab-content">
              {isLoadingVideo ? (
                <div className="loading-state">
                  <span className="loading-spinner">🎬</span>
                  <p>正在載入影音講記清單...</p>
                </div>
              ) : (
                <VideoPlayer
                  tracks={videoTracks}
                  currentTrackIndex={currentVideoIndex}
                  onTrackChange={handleVideoSelect}
                  courseTitle={course.name}
                />
              )}
            </div>
          )}

          {/* 3. PDF Notes Viewer Tab */}
          {activeTab === 'pdf' && (
            <div className="pdf-tab-content">
              {isLoadingPdf ? (
                <div className="loading-state">
                  <span className="loading-spinner">📄</span>
                  <p>正在載入講義 PDF 清單...</p>
                </div>
              ) : (
                <PdfViewer pdfs={pdfTracks} courseTitle={course.name} />
              )}
            </div>
          )}

          {/* 4. Split View: Video + PDF Side-by-Side with Draggable Resizer */}
          {activeTab === 'split' && (
            <div className="split-view-container" ref={splitContainerRef}>
              <div className="split-left-pane" style={{ flex: `0 0 ${splitRatio}%` }}>
                <h3 className="split-pane-title">🎬 影音講記</h3>
                <VideoPlayer
                  tracks={videoTracks}
                  currentTrackIndex={currentVideoIndex}
                  onTrackChange={handleVideoSelect}
                  courseTitle={course.name}
                />
              </div>
              <div
                className="split-resizer"
                onMouseDown={handleSplitMouseDown}
                title="↔️ 左右拖曳調整雙欄比例"
              >
                <span className="split-resizer-knob" />
              </div>
              <div className="split-right-pane" style={{ flex: 1 }}>
                <h3 className="split-pane-title">📄 講義筆記對照</h3>
                <PdfViewer pdfs={pdfTracks} courseTitle={course.name} />
              </div>
            </div>
          )}

          {/* 5. Course Archive Info Tab */}
          {activeTab === 'info' && (
            <div className="info-tab-content">
              <div className="info-card">
                <h3>📖 {course.name} 典藏詳細資料</h3>
                <div className="info-grid">
                  <div className="info-item">
                    <span className="info-label">主講法師</span>
                    <span className="info-value">玅境長老</span>
                  </div>
                  <div className="info-item">
                    <span className="info-label">講述地點</span>
                    <span className="info-value">{course.location || '法雲寺'}</span>
                  </div>
                  <div className="info-item">
                    <span className="info-label">講述日期</span>
                    <span className="info-value">{course.time || '典藏'}</span>
                  </div>
                  <div className="info-item">
                    <span className="info-label">音訊總集數</span>
                    <span className="info-value">{course.total_episodes} 集</span>
                  </div>
                  <div className="info-item">
                    <span className="info-label">分類目錄</span>
                    <span className="info-value">{course.main_menu_title} ➔ {course.sub_menu_title}</span>
                  </div>
                  <div className="info-item">
                    <span className="info-label">音訊資料夾路徑</span>
                    <span className="info-code">{course.audio_path || '無'}</span>
                  </div>
                  {course.video_path && (
                    <div className="info-item">
                      <span className="info-label">影音資料夾路徑</span>
                      <span className="info-code">{course.video_path}</span>
                    </div>
                  )}
                </div>

                {course.comment && (
                  <div className="comment-box">
                    <h4>📝 典藏說明備註</h4>
                    <p>{course.comment}</p>
                  </div>
                )}

                {/* Official Copyright & Archive Provenance Card */}
                <div className="copyright-info-card">
                  <div className="copyright-card-header">
                    <span className="copyright-icon">📜</span>
                    <h4 className="copyright-title">著作權與典藏來源聲明 (Copyright Declaration)</h4>
                  </div>
                  <div className="copyright-card-body">
                    <p className="copyright-text">
                      本課程《<strong>{course.name}</strong>》所收錄之所有經論講述錄音、MP3音訊、影音講記檔及PDF筆記講義，其智慧財產權與著作權<strong>均屬 法雲資訊網 (<a href="https://www.fayun.org" target="_blank" rel="noopener noreferrer" className="copyright-link">fayun.org</a>) 及相關著作權人所有</strong>。
                    </p>
                    <div className="copyright-terms">
                      <div className="term-item">
                        <span className="term-icon">🪷</span>
                        <div className="term-content">
                          <strong>弘法非營利宗旨</strong>
                          <p>本平台純為佛教學人便利研習玅境長老宣說法音之學修工具，完全無償免費流通弘揚正法。</p>
                        </div>
                      </div>
                      <div className="term-item">
                        <span className="term-icon">🚫</span>
                        <div className="term-content">
                          <strong>嚴禁商業使用</strong>
                          <p>未獲法雲資訊網或原始機構合法書面授權，任何團體或個人均不得將本站媒體資料用於營利、販售、付費課程或商業轉載。</p>
                        </div>
                      </div>
                      <div className="term-item">
                        <span className="term-icon">🌐</span>
                        <div className="term-content">
                          <strong>官方原創出處</strong>
                          <p>完整原始典藏與更多開示文庫，請造訪官方網站：<a href="https://www.fayun.org" target="_blank" rel="noopener noreferrer" className="copyright-link">https://www.fayun.org</a></p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
