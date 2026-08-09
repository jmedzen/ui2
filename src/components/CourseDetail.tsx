'use client';

import React, { useState, useEffect } from 'react';
import { CourseItem, PdfItem } from '@/types/course';
import { useAudio } from '@/context/AudioContext';
import VideoPlayer, { VideoTrackInfo } from './VideoPlayer';
import PdfViewer from './PdfViewer';

interface CourseDetailProps {
  course: CourseItem;
}

const AUDIO_EXTS = ['.mp3', '.m4a', '.aac', '.ogg', '.wav', '.wma', '.flac', '.mp4', '.m4v', '.webm', '.mov'];
const VIDEO_EXTS = ['.mp4', '.m4v', '.wmv', '.flv', '.mov', '.avi', '.mkv', '.webm', '.mpg', '.mpeg'];

const extractFilename = (item: any): string => {
  if (typeof item === 'string') return item;
  if (item && typeof item.name === 'string') return item.name;
  return String(item || '');
};

export default function CourseDetail({ course }: CourseDetailProps) {
  const { currentTrack, isPlaying, playTrack, togglePlay } = useAudio();

  const [activeTab, setActiveTab] = useState<'audio' | 'video' | 'pdf' | 'info' | 'split'>('audio');
  const [audioTracks, setAudioTracks] = useState<{ filename: string; proxyUrl: string; url: string; index: number }[]>([]);
  const [videoTracks, setVideoTracks] = useState<VideoTrackInfo[]>([]);
  const [pdfTracks, setPdfTracks] = useState<PdfItem[]>(course.pdfs || []);
  const [currentVideoIndex, setCurrentVideoIndex] = useState<number>(0);
  const [isLoadingAudio, setIsLoadingAudio] = useState<boolean>(false);
  const [isLoadingVideo, setIsLoadingVideo] = useState<boolean>(false);
  const [isLoadingPdf, setIsLoadingPdf] = useState<boolean>(false);
  const [episodeSearch, setEpisodeSearch] = useState<string>('');

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();

    async function loadAudioTracks() {
      setIsLoadingAudio(true);
      setAudioTracks([]);

      let fetchedTracks: { filename: string; proxyUrl: string; url: string; index: number }[] = [];

      const potentialAudioPaths: string[] = [];
      if (course.audio_path) potentialAudioPaths.push(course.audio_path);
      if (course.video_path) potentialAudioPaths.push(course.video_path);

      const uniqueAudioPaths = Array.from(new Set(potentialAudioPaths));

      for (const aPath of uniqueAudioPaths) {
        if (fetchedTracks.length > 0 || !isMounted) break;
        try {
          const res = await fetch('/api/list-files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ src: aPath }),
            signal: controller.signal
          });
          if (res.ok) {
            const rawData = await res.json();
            const dataList = Array.isArray(rawData) ? rawData : (rawData && Array.isArray(rawData.data) ? rawData.data : []);

            if (Array.isArray(dataList) && dataList.length > 0) {
              const audioFiles = dataList
                .map(extractFilename)
                .filter((filename: string) => {
                  const ext = '.' + filename.split('.').pop()?.toLowerCase();
                  return AUDIO_EXTS.includes(ext);
                })
                .sort((a: string, b: string) =>
                  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
                );

              fetchedTracks = audioFiles.map((filename: string, idx: number) => {
                const fullPath = `${aPath}/${filename}`;
                return {
                  index: idx,
                  filename: filename,
                  url: `https://www.fayun.org/ftpadmin${fullPath}`,
                  proxyUrl: `/api/proxy?path=${encodeURIComponent(fullPath)}`
                };
              });
            }
          }
        } catch (e: any) {
          if (e.name !== 'AbortError') {
            console.warn('Failed to fetch remote audio list:', e);
          }
        }
      }

      if (isMounted) {
        setAudioTracks(fetchedTracks);
        setIsLoadingAudio(false);
      }
    }

    async function loadVideoTracks() {
      setIsLoadingVideo(true);
      setVideoTracks([]);
      setCurrentVideoIndex(0);

      let fetchedVideos: VideoTrackInfo[] = [];

      if (course.video_path) {
        try {
          const res = await fetch('/api/list-files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ src: course.video_path }),
            signal: controller.signal
          });
          if (res.ok) {
            const rawData = await res.json();
            const dataList = Array.isArray(rawData) ? rawData : (rawData && Array.isArray(rawData.data) ? rawData.data : []);

            if (Array.isArray(dataList) && dataList.length > 0) {
              const videoFiles = dataList
                .map(extractFilename)
                .filter((filename: string) => {
                  const ext = '.' + filename.split('.').pop()?.toLowerCase();
                  return VIDEO_EXTS.includes(ext);
                })
                .sort((a: string, b: string) =>
                  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
                );

              fetchedVideos = videoFiles.map((filename: string, idx: number) => {
                const fullPath = `${course.video_path}/${filename}`;
                return {
                  index: idx,
                  filename: filename,
                  url: `https://www.fayun.org/ftpadmin${fullPath}`,
                  proxyUrl: `/api/proxy?path=${encodeURIComponent(fullPath)}`
                };
              });
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

      const potentialPaths: string[] = [];
      if ((course as any).lecture_path) potentialPaths.push((course as any).lecture_path);
      if ((course as any).pdf_path) potentialPaths.push((course as any).pdf_path);

      if (course.audio_path) {
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

      const uniquePaths = Array.from(new Set(potentialPaths));
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
            const pdfFilenames: { name: string; folder: string }[] = [];
            const listData = Array.isArray(rawData) ? rawData : (rawData && typeof rawData === 'object' ? (rawData.data || rawData) : []);

            if (Array.isArray(listData)) {
              listData.forEach((item: any) => {
                const fname = extractFilename(item);
                if (fname.toLowerCase().endsWith('.pdf')) {
                  pdfFilenames.push({ name: fname, folder: dirPath });
                }
              });
            } else if (listData && typeof listData === 'object') {
              Object.keys(listData).forEach((key) => {
                const val = listData[key];
                if (Array.isArray(val)) {
                  val.forEach((item: any) => {
                    const fname = extractFilename(item);
                    if (fname.toLowerCase().endsWith('.pdf')) {
                      const subFolder = ['bilu', 'pdf', 'beizhu'].includes(key) ? `${dirPath}/${key}` : dirPath;
                      pdfFilenames.push({ name: fname, folder: subFolder });
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
                  filename: pf.name,
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

  // Restore saved active tab & video index per course on mount/course change
  useEffect(() => {
    try {
      const savedTab = localStorage.getItem(`fayun_last_tab_${course.id}`);
      if (savedTab && ['audio', 'video', 'pdf', 'info', 'split'].includes(savedTab)) {
        setActiveTab(savedTab as any);
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
  }, [course.id]);

  const handleTabClick = (tab: 'audio' | 'video' | 'pdf' | 'info' | 'split') => {
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

  const filteredAudioTracks = audioTracks.filter((t) =>
    episodeSearch.trim() ? t.filename.toLowerCase().includes(episodeSearch.toLowerCase()) : true
  );

  return (
    <div className="course-detail-pane">
      {/* Course Top Title & Information Card */}
      <div className="shadow-card">
        <div className="breadcrumb">
          <span>法雲資訊網</span>
          <span>/</span>
          <span>{course.main_menu_title}</span>
          <span>/</span>
          <span>{course.sub_menu_title}</span>
          <span>/</span>
          <span className="current">{course.name}</span>
        </div>

        <h1 className="course-title">{course.name}</h1>

        <div className="course-meta-tags">
          <span className="meta-tag teacher">主講：玅境長老</span>
          <span className="meta-tag venue">地點：{course.location || '法雲寺'}</span>
          <span className="meta-tag time">日期：{course.time || '典藏'}</span>
          <span className="meta-tag episodes">音訊集數：{course.total_episodes || audioTracks.length} 集</span>
          {course.video_path && (
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
          {course.video_path && (
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
          {course.video_path && pdfTracks.length > 0 && (
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
                <input
                  type="text"
                  placeholder="🔍 搜尋單集檔名或集數..."
                  value={episodeSearch}
                  onChange={(e) => setEpisodeSearch(e.target.value)}
                  className="episode-search-input"
                />
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
                      currentTrack?.courseId === course.id && currentTrack?.filename === track.filename;

                    return (
                      <li
                        key={track.index}
                        className={`episode-item ${isCurrentlyPlayingTrack ? 'playing' : ''}`}
                        onClick={() => playTrack(course.name, course.id, audioTracks, track.index)}
                      >
                        <span className="episode-index">{track.index + 1}</span>
                        <div className="episode-info">
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

          {/* 4. Split View: Video + PDF Side-by-Side */}
          {activeTab === 'split' && (
            <div className="split-view-container">
              <div className="split-left-pane">
                <h3 className="split-pane-title">🎬 影音講記</h3>
                <VideoPlayer
                  tracks={videoTracks}
                  currentTrackIndex={currentVideoIndex}
                  onTrackChange={handleVideoSelect}
                  courseTitle={course.name}
                />
              </div>
              <div className="split-right-pane">
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
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
