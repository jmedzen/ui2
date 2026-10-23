'use client';

import React, { useEffect, useState } from 'react';
import { useAudio } from '@/context/AudioContext';
import {
  REPEAT_LABELS,
  formatSleepRemaining,
  sleepStopClock
} from '@/lib/playbackStore';

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
    resumeAt,
    clearResume,
    repeatMode,
    cycleRepeatMode,
    sleepTimer,
    setSleepMinutes,
    setSleepEndOfEpisode,
    cancelSleepTimer,
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

  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hoverPos, setHoverPos] = useState<number>(0);
  const [isSleepMenuOpen, setIsSleepMenuOpen] = useState<boolean>(false);
  /** Ticks once a second so the countdown label stays live. */
  const [, forceTick] = useState<number>(0);

  useEffect(() => {
    if (!sleepTimer.endsAt) return;
    const interval = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(interval);
  }, [sleepTimer.endsAt]);

  const handleSliderMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setHoverTime(percent * duration);
    setHoverPos(percent * 100);
  };

  // Keyboard Shortcuts (Space: play/pause, Left/Right: seek -5s/+5s, M: mute)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const active = document.activeElement as HTMLElement | null;
      const activeTag = (active?.tagName || '').toLowerCase();
      if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') {
        return; // Ignore shortcuts when typing in inputs
      }
      // A focused iframe (the PDF viewer) makes activeElement the <iframe>
      // element itself, so the tag check above does not catch it and the player
      // would steal Space/arrows from PDF.js. Skip embedded documents and
      // contenteditable hosts too.
      if (activeTag === 'iframe' || active?.isContentEditable) {
        return;
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
    <>
      {/* Compact Floating Restore Trigger when Minimized */}
      {!isExpanded && (
        <button
          className="player-floating-restore-btn"
          onClick={toggleExpanded}
          title={`展開音訊播放器：${currentTrack.filename}`}
        >
          <span className="fab-icon">
            <span className={`soundwave-bars mini ${isPlaying ? 'playing' : ''}`}>
              <span className="bar bar-1" />
              <span className="bar bar-2" />
              <span className="bar bar-3" />
            </span>
          </span>
          <span className="fab-label">{isPlaying ? '播放中' : '播放器'}</span>
          <span className="fab-arrow">▲</span>
        </button>
      )}

      {/* Main Persistent Bottom Player Bar */}
      <div className={`global-player-bar ${isExpanded ? 'expanded' : 'minimized'}`}>
        {/* Top Edge Collapse Tab */}
        {isExpanded && (
          <button
            onClick={toggleExpanded}
            className="global-player-collapse-tab"
            title="隱藏播放列"
          >
            ▼ 隱藏
          </button>
        )}

        <div className="global-player-inner">
          {/* Course & Track Info */}
          <div className="global-player-info">
            <div className="status-indicator">
              <div className={`soundwave-bars ${isPlaying ? 'playing' : ''}`} title={isPlaying ? '正在播放' : '已暫停'}>
                <span className="bar bar-1" />
                <span className="bar bar-2" />
                <span className="bar bar-3" />
                <span className="bar bar-4" />
              </div>
              {/* Announced to screen readers when playback state changes; the
                  visual status text alone is invisible to them. */}
              <span className="status-text" role="status" aria-live="polite">
                {isPlaying ? '播放中' : '已暫停'}
              </span>
            </div>
            <div className="title-block">
              <h4 className="track-name-text" title={currentTrack.filename}>
                {currentTrack.filename}
              </h4>
              <span className="course-name-text">
                {currentTrack.courseTitle} • 第 {currentTrack.index + 1} / {playlist.length} 集
              </span>
              {resumeAt > 0 && currentTime < resumeAt - 2 && (
                <span className="resume-hint-chip" title="已從上次聽到的位置接續播放">
                  ⏱️ 從 {formatTime(resumeAt)} 續聽
                  <button
                    className="resume-restart-btn"
                    onClick={() => {
                      clearResume();
                      seekTo(0);
                    }}
                    title="從頭開始播放並清除此集的續聽紀錄"
                  >
                    從頭
                  </button>
                </span>
              )}
              {currentTrack.activeRoute === 'direct' ? (
                <span className="route-badge-tag route-badge-direct" title="播放來源：Fayun.org 直連 (主機背景預載中)">
                  🌐 Direct Fayun (⏳ 預載中)
                </span>
              ) : currentTrack.isServerCached ? (
                <span className="route-badge-tag route-badge-cached" title="播放來源：網頁主機磁碟 (0ms 本地串流)">
                  ⚡ 網頁主機 (✅ 已快取)
                </span>
              ) : (
                <span className="route-badge-tag route-badge-caching" title="播放來源：網頁主機 (邊聽邊快取中)">
                  ⚡ 網頁主機 (⏳ 邊聽邊快取...)
                </span>
              )}
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
              <div
                className="slider-wrapper"
                onMouseMove={handleSliderMouseMove}
                onMouseLeave={() => setHoverTime(null)}
              >
                {hoverTime !== null && (
                  <div
                    className="slider-hover-bubble"
                    style={{ left: `${hoverPos}%` }}
                  >
                    {formatTime(hoverTime)}
                  </div>
                )}
                <input
                  type="range"
                  min={0}
                  max={duration || 100}
                  value={currentTime}
                  onChange={(e) => seekTo(parseFloat(e.target.value))}
                  className="progress-slider"
                />
              </div>
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

            <div className="player-extra-controls">
              <button
                onClick={cycleRepeatMode}
                className={`player-tool-btn repeat-${repeatMode} ${repeatMode !== 'off' ? 'active' : ''}`}
                title={`循環模式：${REPEAT_LABELS[repeatMode]}（點擊切換）`}
                aria-label={`循環模式：${REPEAT_LABELS[repeatMode]}`}
              >
                {repeatMode === 'one' ? '🔂' : '🔁'}
              </button>

              <div className="sleep-timer-widget">
                <button
                  onClick={() => setIsSleepMenuOpen((prev) => !prev)}
                  className={`player-tool-btn ${sleepTimer.endsAt || sleepTimer.endOfEpisode ? 'active' : ''}`}
                  title="睡眠定時器：時間到自動停止播放"
                  aria-expanded={isSleepMenuOpen}
                  aria-haspopup="menu"
                >
                  🌙
                  {sleepTimer.endsAt && (
                    <span className="sleep-countdown">{formatSleepRemaining(sleepTimer.endsAt)}</span>
                  )}
                  {sleepTimer.endOfEpisode && <span className="sleep-countdown">集末</span>}
                </button>

                {isSleepMenuOpen && (
                  <div className="sleep-timer-menu" role="menu">
                    <div className="sleep-menu-title">🌙 睡眠定時器</div>
                    {[10, 15, 30, 45, 60, 90].map((minutes) => (
                      <button
                        key={minutes}
                        role="menuitem"
                        className="sleep-menu-item"
                        onClick={() => {
                          setSleepMinutes(minutes);
                          setIsSleepMenuOpen(false);
                        }}
                      >
                        {minutes} 分鐘後停止
                      </button>
                    ))}
                    <button
                      role="menuitem"
                      className="sleep-menu-item"
                      onClick={() => {
                        setSleepEndOfEpisode();
                        setIsSleepMenuOpen(false);
                      }}
                    >
                      本集播完即停
                    </button>
                    {(sleepTimer.endsAt || sleepTimer.endOfEpisode) && (
                      <button
                        role="menuitem"
                        className="sleep-menu-item cancel"
                        onClick={() => {
                          cancelSleepTimer();
                          setIsSleepMenuOpen(false);
                        }}
                      >
                        ✕ 取消定時
                      </button>
                    )}
                    {sleepTimer.endsAt && (
                      <div className="sleep-menu-hint">
                        將於 {sleepStopClock(sleepTimer.endsAt)} 停止播放
                      </div>
                    )}
                  </div>
                )}
              </div>
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

            <button
              onClick={toggleExpanded}
              className="toggle-btn"
              title="隱藏播放列 (可在右下角隨時展開)"
            >
              ▼ 隱藏
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
