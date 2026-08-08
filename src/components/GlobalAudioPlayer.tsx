'use client';

import React, { useEffect } from 'react';
import { useAudio } from '@/context/AudioContext';

export default function GlobalAudioPlayer() {
  const {
    currentTrack,
    playlist,
    isPlaying,
    currentTime,
    duration,
    playbackRate,
    volume,
    isMuted,
    isExpanded,
    togglePlay,
    playNext,
    playPrev,
    seekTo,
    seekRelative,
    setRate,
    setVol,
    toggleMute,
    toggleExpanded
  } = useAudio();

  // Keyboard Shortcuts (Space: play/pause, Left/Right: seek -5s/+5s, M: mute)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeTag = (document.activeElement?.tagName || '').toLowerCase();
      if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') {
        return; // Ignore shortcuts when typing in inputs
      }

      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        seekRelative(-5);
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        seekRelative(5);
      } else if (e.code === 'KeyM') {
        e.preventDefault();
        toggleMute();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePlay, seekRelative, toggleMute]);

  if (!currentTrack) return null;

  const formatTime = (sec: number) => {
    if (isNaN(sec) || sec === 0) return '00:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
  };

  return (
    <div className={`global-player-bar ${isExpanded ? 'expanded' : 'minimized'}`}>
      <div className="global-player-inner">
        {/* Course & Track Info */}
        <div className="global-player-info">
          <div className="status-indicator">
            <span className={`pulse-dot ${isPlaying ? 'active' : ''}`}></span>
            <span className="status-text">{isPlaying ? '播放中' : '已暫停'}</span>
          </div>
          <div className="title-block">
            <h4 className="track-name-text" title={currentTrack.filename}>
              {currentTrack.filename}
            </h4>
            <span className="course-name-text">
              {currentTrack.courseTitle} • 第 {currentTrack.index + 1} / {playlist.length} 集
            </span>
            <span className="route-badge-tag" title="雙路徑自動測速分流與網頁主機 15GB 快取">
              {currentTrack.activeRoute === 'direct' ? '🌐 直連 Fayun' : '⚡ 網頁主機代理 (快取中)'}
            </span>
          </div>
        </div>

        {/* Playback Controls & Progress Bar */}
        <div className="global-player-controls">
          <div className="main-buttons-row">
            <button
              onClick={() => seekRelative(-10)}
              className="ctrl-btn-sm"
              title="倒退 10 秒 (← 鍵 倒退5秒)"
            >
              ⏪ -10s
            </button>
            <button
              onClick={playPrev}
              disabled={currentTrack.index === 0}
              className="ctrl-btn-sm"
              title="上一集"
            >
              ⏮️
            </button>
            <button
              onClick={togglePlay}
              className="ctrl-btn-lg play-main-btn"
              title={isPlaying ? '暫停 (空白鍵)' : '播放 (空白鍵)'}
            >
              {isPlaying ? '⏸️' : '▶️'}
            </button>
            <button
              onClick={playNext}
              disabled={currentTrack.index === playlist.length - 1}
              className="ctrl-btn-sm"
              title="下一集"
            >
              ⏭️
            </button>
            <button
              onClick={() => seekRelative(10)}
              className="ctrl-btn-sm"
              title="快進 10 秒 (→ 鍵 快進5秒)"
            >
              +10s ⏩
            </button>
          </div>

          <div className="progress-row">
            <span className="time-text">{formatTime(currentTime)}</span>
            <input
              type="range"
              min={0}
              max={duration || 100}
              value={currentTime}
              onChange={(e) => seekTo(parseFloat(e.target.value))}
              className="progress-slider"
            />
            <span className="time-text">{formatTime(duration)}</span>
          </div>
        </div>

        {/* Right Tools (Speed, Volume, Download, Toggle) */}
        <div className="global-player-tools">
          <div className="speed-buttons-sm">
            {[0.75, 1.0, 1.25, 1.5, 2.0].map((rate) => (
              <button
                key={rate}
                onClick={() => setRate(rate)}
                className={`speed-btn-sm ${playbackRate === rate ? 'active' : ''}`}
              >
                {rate}x
              </button>
            ))}
          </div>

          <div className="volume-widget">
            <button onClick={toggleMute} className="vol-btn" title="靜音 (M 鍵)">
              {isMuted ? '🔇' : '🔊'}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={isMuted ? 0 : volume}
              onChange={(e) => setVol(parseFloat(e.target.value))}
              className="volume-slider-sm"
            />
          </div>

          <a
            href={currentTrack.proxyUrl}
            download={currentTrack.filename}
            target="_blank"
            rel="noopener noreferrer"
            className="download-btn-sm"
            title="下載音訊 MP3/M4A"
          >
            ⬇️
          </a>

          <button onClick={toggleExpanded} className="toggle-btn" title={isExpanded ? '最小化' : '展開'}>
            {isExpanded ? '▼' : '▲'}
          </button>
        </div>
      </div>
    </div>
  );
}
