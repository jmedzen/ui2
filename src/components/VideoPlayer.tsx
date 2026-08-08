'use client';

import React, { useRef, useState, useEffect } from 'react';
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

export default function VideoPlayer({
  tracks,
  currentTrackIndex,
  onTrackChange,
  courseTitle,
}: VideoPlayerProps) {
  const { isPlaying: isAudioPlaying, togglePlay: toggleAudioPlay } = useAudio();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playbackRate, setPlaybackRate] = useState<number>(1.0);

  const currentTrack = tracks[currentTrackIndex];

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
    if (isAudioPlaying) {
      toggleAudioPlay();
    }
    onTrackChange(index);
  };

  if (!currentTrack) return null;

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
            if (currentTrackIndex < tracks.length - 1) {
              handleSelectTrack(currentTrackIndex + 1);
            }
          }}
        />
      </div>

      {tracks.length > 1 && (
        <div className="video-episodes-bar">
          <span className="episodes-bar-title">集數選擇：</span>
          <div className="episodes-pills">
            {tracks.map((t, idx) => (
              <button
                key={idx}
                onClick={() => handleSelectTrack(idx)}
                className={`episode-pill ${idx === currentTrackIndex ? 'active' : ''}`}
              >
                第 {idx + 1} 集
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
