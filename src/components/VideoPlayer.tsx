'use client';

import React, { useRef, useState, useEffect, useMemo } from 'react';
import { useAudio } from '@/context/AudioContext';

export interface VideoTrackInfo {
  index: number;
  filename: string;
  url: string;
  proxyUrl: string;
}

interface VideoPlayerProps {
  tracks: VideoTrackInfo[];
  currentTrackIndex: number;
  onTrackChange: (index: number) => void;
  courseTitle: string;
}

const PAGE_SIZE = 20;

export default function VideoPlayer({
  tracks,
  currentTrackIndex,
  onTrackChange,
  courseTitle,
}: VideoPlayerProps) {
  const { isPlaying: isAudioPlaying, togglePlay: toggleAudioPlay } = useAudio();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playbackRate, setPlaybackRate] = useState<number>(1.0);
  const [autoPlayNext, setAutoPlayNext] = useState<boolean>(true);

  // Range page tab state (0 = 1..20, 1 = 21..40, etc.)
  const [selectedRangePage, setSelectedRangePage] = useState<number>(0);

  const currentTrack = tracks[currentTrackIndex];

  // Sync range tab when currentTrackIndex changes
  useEffect(() => {
    const pageOfCurrentTrack = Math.floor(currentTrackIndex / PAGE_SIZE);
    setSelectedRangePage(pageOfCurrentTrack);
  }, [currentTrackIndex]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate]);

  useEffect(() => {
    if (videoRef.current && currentTrack) {
      videoRef.current.src = currentTrack.proxyUrl;
      videoRef.current.load();
    }
  }, [currentTrackIndex, currentTrack]);

  const handleVideoPlay = () => {
    // When video starts playing, pause background audio player if it is currently playing
    if (isAudioPlaying) {
      toggleAudioPlay();
    }
  };

  const handleSelectTrack = (index: number) => {
    if (index < 0 || index >= tracks.length) return;
    if (isAudioPlaying) {
      toggleAudioPlay();
    }
    onTrackChange(index);
  };

  // Generate range tabs if total tracks > 20
  const rangePagesCount = Math.ceil(tracks.length / PAGE_SIZE);

  const currentRangeTracks = useMemo(() => {
    if (tracks.length <= PAGE_SIZE) return tracks;
    const start = selectedRangePage * PAGE_SIZE;
    return tracks.slice(start, start + PAGE_SIZE);
  }, [tracks, selectedRangePage]);

  if (!currentTrack) return null;

  const hasPrev = currentTrackIndex > 0;
  const hasNext = currentTrackIndex < tracks.length - 1;

  return (
    <div className="video-player-card">
      <div className="video-header-bar">
        <div className="video-title-info">
          <span className="video-badge">🎥 影音視訊</span>
          <h4 className="video-name">{currentTrack.filename}</h4>
          <span className="video-sub-info">
            {courseTitle} • 第 {currentTrackIndex + 1} / {tracks.length} 集
          </span>
        </div>

        <div className="video-header-actions">
          <div className="speed-buttons">
            {[0.75, 1.0, 1.25, 1.5, 2.0].map((rate) => (
              <button
                key={rate}
                onClick={() => setPlaybackRate(rate)}
                className={`speed-btn ${playbackRate === rate ? 'active' : ''}`}
              >
                {rate}x
              </button>
            ))}
          </div>
          <a
            href={currentTrack.proxyUrl}
            download={currentTrack.filename}
            target="_blank"
            rel="noopener noreferrer"
            className="download-btn"
            title="下載影片 MP4/M4V"
          >
            ⬇️ 下載影片
          </a>
        </div>
      </div>

      <div className="video-frame-container">
        <video
          ref={videoRef}
          controls
          playsInline
          controlsList="nodownload"
          className="video-element"
          onPlay={handleVideoPlay}
          onEnded={() => {
            if (autoPlayNext && hasNext) {
              handleSelectTrack(currentTrackIndex + 1);
            }
          }}
        />
      </div>

      {/* Episode Navigation & Selection Panel */}
      {tracks.length > 1 && (
        <div className="video-episodes-panel">
          {/* Top Quick Control Row */}
          <div className="video-nav-control-bar">
            <button
              onClick={() => handleSelectTrack(currentTrackIndex - 1)}
              disabled={!hasPrev}
              className="video-nav-btn"
              title="播放上一集"
            >
              ◀ 上一集
            </button>

            {/* Dropdown Selection Menu for Instant Jump */}
            <div className="video-dropdown-wrapper">
              <select
                value={currentTrackIndex}
                onChange={(e) => handleSelectTrack(Number(e.target.value))}
                className="video-dropdown-select"
                title="快速選集"
              >
                {tracks.map((t, idx) => (
                  <option key={idx} value={idx}>
                    第 {idx + 1} 集 / 共 {tracks.length} 集 - {t.filename}
                  </option>
                ))}
              </select>
            </div>

            <button
              onClick={() => handleSelectTrack(currentTrackIndex + 1)}
              disabled={!hasNext}
              className="video-nav-btn"
              title="播放下一集"
            >
              下一集 ▶
            </button>

            <label className="auto-next-toggle" title="影片播放結束後自動播放下一集">
              <input
                type="checkbox"
                checked={autoPlayNext}
                onChange={(e) => setAutoPlayNext(e.target.checked)}
              />
              <span>🔄 自動連播</span>
            </label>
          </div>

          {/* Range Pagination Tabs if > 20 tracks */}
          {rangePagesCount > 1 && (
            <div className="video-range-tabs">
              <span className="range-tabs-label">分段快選：</span>
              {Array.from({ length: rangePagesCount }).map((_, pIdx) => {
                const startNum = pIdx * PAGE_SIZE + 1;
                const endNum = Math.min((pIdx + 1) * PAGE_SIZE, tracks.length);
                const isCurrentPage = selectedRangePage === pIdx;

                return (
                  <button
                    key={pIdx}
                    onClick={() => setSelectedRangePage(pIdx)}
                    className={`range-tab-btn ${isCurrentPage ? 'active' : ''}`}
                  >
                    {startNum} - {endNum} 集
                  </button>
                );
              })}
            </div>
          )}

          {/* Compact Multi-Column Grid Buttons */}
          <div className="video-grid-wrapper">
            <div className="video-grid-buttons">
              {currentRangeTracks.map((t) => {
                const idx = t.index;
                const isActive = idx === currentTrackIndex;

                return (
                  <button
                    key={idx}
                    onClick={() => handleSelectTrack(idx)}
                    className={`video-grid-btn ${isActive ? 'active' : ''}`}
                    title={t.filename}
                  >
                    <span className="grid-ep-num">第 {idx + 1} 集</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
