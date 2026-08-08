'use client';

import React, { useState, useEffect } from 'react';
import { CourseItem, PdfItem } from '@/types/course';
import { useAudio } from '@/context/AudioContext';
import VideoPlayer, { VideoTrackInfo } from './VideoPlayer';
import PdfViewer from './PdfViewer';

interface CourseDetailProps {
  course: CourseItem;
}

const AUDIO_EXTS = ['.mp3', '.m4a', '.aac', '.ogg', '.wav', '.wma', '.flac'];
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

    async function loadAudioTracks() {
      setIsLoadingAudio(true);
      setAudioTracks([]);

      let fetchedTracks: { filename: string; proxyUrl: string; url: string; index: number }[] = [];

      if (course.audio_path) {
        try {
          const res = await fetch('/api/list-files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ src: course.audio_path })
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
                const fullPath = `${course.audio_path}/${filename}`;
                return {
                  index: idx,
                  filename: filename,
                  url: `https://www.fayun.org/ftpadmin${fullPath}`,
                  proxyUrl: `/api/proxy?path=${encodeURIComponent(fullPath)}`
                };
              });
            }
          }
        } catch (e) {
          console.warn('Failed to fetch remote audio list:', e);
        }
      }

      if (fetchedTracks.length === 0 && course.total_episodes > 0 && course.audio_path) {
        const total = course.total_episodes;
        for (let i = 1; i <= total; i++) {
          const numStr = i < 10 ? `0${i}` : `${i}`;
          const filename = `${course.name}${numStr}.mp3`;
          const fullPath = `${course.audio_path}/${filename}`;
          fetchedTracks.push({
            index: i - 1,
            filename: `第 ${numStr} 集 (${filename})`,
            url: `https://www.fayun.org/ftpadmin${fullPath}`,
            proxyUrl: `/api/proxy?path=${encodeURIComponent(fullPath)}`
          });
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
            body: JSON.stringify({ src: course.video_path })
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
        } catch (e) {
          console.warn('Failed to fetch remote video list:', e);
        }
      }

      if (isMounted) {
        setVideoTracks(fetchedVideos);
        setIsLoadingVideo(false);
      }
    }

    async function loadPdfTracks() {
      setIsLoadingPdf(true);
      setPdfTracks(course.pdfs || []);

      const potentialPaths: string[] = [];
      if (course.lecture_path) potentialPaths.push(course.lecture_path);

      if (course.audio_path) {
        const parent = course.audio_path.replace(/\/audio\/?$/, '');
        potentialPaths.push(parent, `${parent}/bilu`, `${parent}/beizhu`);
      }
      if (course.video_path) {
        const parent = course.video_path.replace(/\/video\/?$/, '');
        potentialPaths.push(parent, `${parent}/bilu`, `${parent}/beizhu`);
      }

      const uniquePaths = Array.from(new Set(potentialPaths));
      const fetchedPdfs: PdfItem[] = [];

      for (const dirPath of uniquePaths) {
        try {
          const res = await fetch('/api/list-files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ src: dirPath })
          });
          if (res.ok) {
            const rawData = await res.json();
            const data = rawData?.data !== undefined ? rawData.data : rawData;

            const pdfFilenames: { name: string; folder: string }[] = [];

            if (Array.isArray(data)) {
              data.forEach((item: any) => {
                const fname = extractFilename(item);
                if (fname.toLowerCase().endsWith('.pdf')) {
                  pdfFilenames.push({ name: fname, folder: dirPath });
                }
              });
            } else if (data && typeof data === 'object') {
              Object.keys(data).forEach((key) => {
                const list = data[key];
                if (Array.isArray(list)) {
                  list.forEach((item: any) => {
                    const fname = extractFilename(item);
                    if (fname.toLowerCase().endsWith('.pdf')) {
                      const subFolder = key === 'bilu' || key === 'beizhu' ? `${dirPath}/${key}` : dirPath;
                      pdfFilenames.push({ name: fname, folder: subFolder });
                    }
                  });
                }
              });
            }

            pdfFilenames.forEach((pf, idx) => {
              const pdfUrl = `https://www.fayun.org/ftpadmin${pf.folder}/${pf.name}`;
              if (!fetchedPdfs.some((p) => p.url === pdfUrl)) {
                fetchedPdfs.push({
                  num: fetchedPdfs.length + 1,
                  filename: pf.name,
                  url: pdfUrl
                });
              }
            });
          }
        } catch (e) {
          console.warn('Failed to fetch remote PDF list:', e);
        }
      }

      if (isMounted) {
        if (fetchedPdfs.length > 0) {
          setPdfTracks(fetchedPdfs);
        }
        setIsLoadingPdf(false);
      }
    }

    loadAudioTracks();
    loadVideoTracks();
    loadPdfTracks();

    return () => {
      isMounted = false;
    };
  }, [course]);

  const handleTabClick = (tab: 'audio' | 'video' | 'pdf' | 'info' | 'split') => {
    if (tab === 'video' && isPlaying) {
      togglePlay();
    }
    setActiveTab(tab);
  };

  const handleVideoSelect = (idx: number) => {
    if (isPlaying) {
      togglePlay();
    }
    setCurrentVideoIndex(idx);
  };

  const filteredAudioTracks = audioTracks.filter((t) =>
    t.filename.toLowerCase().includes(episodeSearch.toLowerCase())
  );

  const hasVideoPath = !!course.video_path;
  const hasPdfs = pdfTracks.length > 0;

  return (
    <main className="course-detail-pane">
      {/* Header Banner */}
      <header className="course-header shadow-card">
        <div className="breadcrumb">
          <span>{course.main_menu_title}</span>
          <span className="sep">/</span>
          <span>{course.sub_menu_title}</span>
          <span className="sep">/</span>
          <span className="current">{course.topic_title || '講記'}</span>
        </div>

        <h2 className="course-title">{course.name}</h2>

        <div className="course-meta-tags">
          <span className="meta-tag venue">📍 {course.location || '美國法雲寺禪學院'}</span>
          {course.time && <span className="meta-tag year">🗓️ {course.time} 年</span>}
          <span className="meta-tag teacher">👤 主講：玅境長老</span>
          {audioTracks.length > 0 && (
            <span className="meta-tag episodes">🎙️ 全 {audioTracks.length} 集音訊</span>
          )}
          {videoTracks.length > 0 && (
            <span className="meta-tag video-badge-tag">🎥 {videoTracks.length} 集影音影片</span>
          )}
          {hasPdfs && (
            <span className="meta-tag notes">📚 {pdfTracks.length} 份筆記講義</span>
          )}
        </div>
      </header>

      {/* Navigation Tabs */}
      <nav className="tab-navigation">
        <button
          className={`tab-btn ${activeTab === 'audio' ? 'active' : ''}`}
          onClick={() => handleTabClick('audio')}
        >
          🎧 音訊目錄 ({audioTracks.length} 集)
        </button>

        {hasPdfs && audioTracks.length > 0 && (
          <button
            className={`tab-btn split-btn ${activeTab === 'split' ? 'active' : ''}`}
            onClick={() => handleTabClick('split')}
            title="同時瀏覽 PDF 講義與點選收聽音訊"
          >
            📖 雙欄對照閱讀
          </button>
        )}

        {(hasVideoPath || videoTracks.length > 0) && (
          <button
            className={`tab-btn ${activeTab === 'video' ? 'active' : ''}`}
            onClick={() => handleTabClick('video')}
          >
            🎥 影音影片 ({videoTracks.length} 集)
          </button>
        )}

        <button
          className={`tab-btn ${activeTab === 'pdf' ? 'active' : ''}`}
          onClick={() => handleTabClick('pdf')}
        >
          📖 講義筆記 PDF ({pdfTracks.length} 份)
        </button>

        <button
          className={`tab-btn ${activeTab === 'info' ? 'active' : ''}`}
          onClick={() => handleTabClick('info')}
        >
          ℹ️ 課程簡介
        </button>
      </nav>

      {/* Tab Contents */}
      <div className="tab-content">
        {activeTab === 'audio' && (
          <section className="audio-tab-content">
            <div className="track-list-toolbar">
              <input
                type="text"
                placeholder="搜尋音訊單集..."
                value={episodeSearch}
                onChange={(e) => setEpisodeSearch(e.target.value)}
                className="episode-search-input"
              />
              <span className="track-count-info">共 {filteredAudioTracks.length} 集</span>
            </div>

            {isLoadingAudio ? (
              <div className="loading-state shadow-card">
                <span className="spinner">⏳</span> 正在載入音訊檔案目錄...
              </div>
            ) : filteredAudioTracks.length > 0 ? (
              <ul className="episodes-list">
                {filteredAudioTracks.map((track) => {
                  const isCurrentPlayingTrack =
                    currentTrack &&
                    currentTrack.courseId === course.id &&
                    currentTrack.index === track.index;

                  return (
                    <li
                      key={track.index}
                      className={`episode-item ${isCurrentPlayingTrack ? 'playing' : ''}`}
                      onClick={() => {
                        playTrack(course.name, course.id, audioTracks, track.index);
                      }}
                    >
                      <div className="episode-index">{track.index + 1}</div>
                      <div className="episode-info">
                        <span className="episode-name">{track.filename}</span>
                      </div>
                      <div className="episode-actions">
                        {isCurrentPlayingTrack ? (
                          <span className="now-playing-label">
                            <span className="pulse-dot"></span> {isPlaying ? '播放中' : '已暫停'}
                          </span>
                        ) : (
                          <button className="play-track-btn">▶ 播放</button>
                        )}
                        <a
                          href={track.proxyUrl}
                          download={track.filename}
                          onClick={(e) => e.stopPropagation()}
                          className="download-track-link"
                          title="下載音訊 MP3/M4A"
                        >
                          ⬇️ 下載
                        </a>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="no-audio-state shadow-card">
                <p>此課程目前未收錄線上音訊檔。</p>
              </div>
            )}
          </section>
        )}

        {/* Split-Screen View */}
        {activeTab === 'split' && (
          <section className="split-view-container">
            <div className="split-left-pane">
              <h3 className="split-pane-title">🎙️ 音訊集數 ({filteredAudioTracks.length} 集)</h3>
              <ul className="episodes-list compact-list">
                {filteredAudioTracks.map((track) => {
                  const isCurrentPlayingTrack =
                    currentTrack &&
                    currentTrack.courseId === course.id &&
                    currentTrack.index === track.index;

                  return (
                    <li
                      key={track.index}
                      className={`episode-item ${isCurrentPlayingTrack ? 'playing' : ''}`}
                      onClick={() => {
                        playTrack(course.name, course.id, audioTracks, track.index);
                      }}
                    >
                      <div className="episode-index">{track.index + 1}</div>
                      <div className="episode-info">
                        <span className="episode-name">{track.filename}</span>
                      </div>
                      <div className="episode-actions">
                        {isCurrentPlayingTrack ? (
                          <span className="now-playing-label">▶️</span>
                        ) : (
                          <button className="play-track-btn">▶</button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="split-right-pane">
              <PdfViewer pdfs={pdfTracks} courseTitle={course.name} />
            </div>
          </section>
        )}

        {activeTab === 'video' && (
          <section className="video-tab-content">
            {isLoadingVideo ? (
              <div className="loading-state shadow-card">
                <span className="spinner">⏳</span> 正在載入影片檔案目錄...
              </div>
            ) : videoTracks.length > 0 ? (
              <div className="video-section-wrapper">
                <VideoPlayer
                  tracks={videoTracks}
                  currentTrackIndex={currentVideoIndex}
                  onTrackChange={handleVideoSelect}
                  courseTitle={course.name}
                />

                <h3 className="video-list-heading">影片集數清單 ({videoTracks.length} 集)</h3>
                <ul className="episodes-list video-episodes-list">
                  {videoTracks.map((vTrack) => {
                    const isCurrent = vTrack.index === currentVideoIndex;
                    return (
                      <li
                        key={vTrack.index}
                        className={`episode-item video-item ${isCurrent ? 'playing' : ''}`}
                        onClick={() => handleVideoSelect(vTrack.index)}
                      >
                        <div className="episode-index">🎬 {vTrack.index + 1}</div>
                        <div className="episode-info">
                          <span className="episode-name">{vTrack.filename}</span>
                        </div>
                        <div className="episode-actions">
                          {isCurrent ? (
                            <span className="now-playing-label">▶️ 觀看中</span>
                          ) : (
                            <button className="play-track-btn">▶ 觀看影片</button>
                          )}
                          <a
                            href={vTrack.proxyUrl}
                            download={vTrack.filename}
                            onClick={(e) => e.stopPropagation()}
                            className="download-track-link"
                            title="下載影片"
                          >
                            ⬇️ 下載 MP4/M4V
                          </a>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : (
              <div className="no-audio-state shadow-card">
                <p>此課程目前未提供線上影音影片檔案。</p>
              </div>
            )}
          </section>
        )}

        {activeTab === 'pdf' && (
          <section className="pdf-tab-content">
            {isLoadingPdf ? (
              <div className="loading-state shadow-card">
                <span className="spinner">⏳</span> 正在從 fayun.org 載入最新 PDF 講義清單...
              </div>
            ) : (
              <PdfViewer pdfs={pdfTracks} courseTitle={course.name} />
            )}
          </section>
        )}

        {activeTab === 'info' && (
          <section className="info-tab-content">
            <div className="info-card">
              <h3>典藏資訊說明</h3>
              <div className="info-grid">
                <div className="info-item">
                  <span className="info-label">經典/課程名稱:</span>
                  <span className="info-value">{course.name}</span>
                </div>
                <div className="info-item">
                  <span className="info-label">講述地點:</span>
                  <span className="info-value">{course.location || '美國法雲寺禪學院'}</span>
                </div>
                <div className="info-item">
                  <span className="info-label">講述年份:</span>
                  <span className="info-value">{course.time ? `${course.time} 年` : '未載明'}</span>
                </div>
                <div className="info-item">
                  <span className="info-label">分類歸屬:</span>
                  <span className="info-value">
                    {course.main_menu_title} / {course.sub_menu_title} ({course.topic_title})
                  </span>
                </div>
                <div className="info-item">
                  <span className="info-label">音訊總集數:</span>
                  <span className="info-value">{audioTracks.length} 集</span>
                </div>
                <div className="info-item">
                  <span className="info-label">影片總集數:</span>
                  <span className="info-value">{videoTracks.length} 集</span>
                </div>
                <div className="info-item">
                  <span className="info-label">講義文件數:</span>
                  <span className="info-value">{pdfTracks.length} 份</span>
                </div>
                <div className="info-item">
                  <span className="info-label">音訊目錄路徑:</span>
                  <code className="info-code">{course.audio_path || '無'}</code>
                </div>
                <div className="info-item">
                  <span className="info-label">影片目錄路徑:</span>
                  <code className="info-code">{course.video_path || '無'}</code>
                </div>
                <div className="info-item">
                  <span className="info-label">筆記講義路徑:</span>
                  <code className="info-code">{course.lecture_path || '無'}</code>
                </div>
              </div>
              {course.comment && (
                <div className="comment-box">
                  <h4>備註事項：</h4>
                  <p>{course.comment}</p>
                </div>
              )}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
