'use client';

import React, { useRef, useState, useEffect } from 'react';

export interface TrackInfo {
  index: number;
  filename: string;
  url: string;
  proxyUrl: string;
}

interface AudioPlayerProps {
  tracks: TrackInfo[];
  currentTrackIndex: number;
  onTrackChange: (index: number) => void;
  courseTitle: string;
  autoPlay?: boolean;
}

export default function AudioPlayer({
  tracks,
  currentTrackIndex,
  onTrackChange,
  courseTitle,
  autoPlay = true
}: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [volume, setVolume] = useState(1.0);
  const [isMuted, setIsMuted] = useState(false);

  const currentTrack = tracks[currentTrackIndex];

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate]);

  useEffect(() => {
    if (audioRef.current && currentTrack) {
      audioRef.current.src = currentTrack.proxyUrl;
      audioRef.current.load();
      if (autoPlay) {
        audioRef.current
          .play()
          .then(() => setIsPlaying(true))
          .catch((err) => {
            console.warn('Audio play prevented by browser policy:', err);
            setIsPlaying(false);
          });
      }
    }
  }, [currentTrackIndex, currentTrack, autoPlay]);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current
        .play()
        .then(() => setIsPlaying(true))
        .catch(() => setIsPlaying(false));
    }
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
      setDuration(audioRef.current.duration || 0);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    if (audioRef.current) {
      audioRef.current.currentTime = time;
      setCurrentTime(time);
    }
  };

  const handleNext = () => {
    if (currentTrackIndex < tracks.length - 1) {
      onTrackChange(currentTrackIndex + 1);
    }
  };

  const handlePrev = () => {
    if (currentTrackIndex > 0) {
      onTrackChange(currentTrackIndex - 1);
    }
  };

  const handleEnded = () => {
    if (currentTrackIndex < tracks.length - 1) {
      onTrackChange(currentTrackIndex + 1);
    } else {
      setIsPlaying(false);
    }
  };

  const handleSpeedChange = (rate: number) => {
    setPlaybackRate(rate);
  };

  const formatTime = (sec: number) => {
    if (isNaN(sec) || sec === 0) return '00:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
  };

  if (!currentTrack) return null;

  return (
    <div className="audio-player-card">
      <audio
        ref={audioRef}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleTimeUpdate}
        onEnded={handleEnded}
      />

      <div className="player-meta">
        <div className="playing-badge">
          <span className="pulse-dot"></span> {isPlaying ? '播放中' : '已準備'}
        </div>
        <div className="track-title-info">
          <h4 className="track-name">{currentTrack.filename}</h4>
          <span className="course-sub-title">
            {courseTitle} • 第 {currentTrackIndex + 1} / {tracks.length} 集
          </span>
        </div>
        <a
          href={currentTrack.proxyUrl}
          download={currentTrack.filename}
          target="_blank"
          rel="noopener noreferrer"
          className="download-btn"
          title="下載音訊 MP3/M4A"
        >
          ⬇️ 下載音訊
        </a>
      </div>

      <div className="player-progress-row">
        <span className="time-text">{formatTime(currentTime)}</span>
        <input
          type="range"
          min={0}
          max={duration || 100}
          value={currentTime}
          onChange={handleSeek}
          className="progress-slider"
        />
        <span className="time-text">{formatTime(duration)}</span>
      </div>

      <div className="player-controls-row">
        <div className="speed-buttons">
          {[0.75, 1.0, 1.25, 1.5, 2.0].map((rate) => (
            <button
              key={rate}
              onClick={() => handleSpeedChange(rate)}
              className={`speed-btn ${playbackRate === rate ? 'active' : ''}`}
            >
              {rate}x
            </button>
          ))}
        </div>

        <div className="main-playback-btns">
          <button
            onClick={handlePrev}
            disabled={currentTrackIndex === 0}
            className="ctrl-btn"
            title="上一集"
          >
            ⏮️
          </button>
          <button
            onClick={togglePlay}
            className="ctrl-btn play-main-btn"
            title={isPlaying ? '暫停' : '播放'}
          >
            {isPlaying ? '⏸️ 暫停' : '▶️ 播放'}
          </button>
          <button
            onClick={handleNext}
            disabled={currentTrackIndex === tracks.length - 1}
            className="ctrl-btn"
            title="下一集"
          >
            ⏭️
          </button>
        </div>

        <div className="volume-control">
          <button
            onClick={() => {
              if (audioRef.current) {
                audioRef.current.muted = !isMuted;
                setIsMuted(!isMuted);
              }
            }}
            className="vol-btn"
          >
            {isMuted ? '🔇' : '🔊'}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={isMuted ? 0 : volume}
            onChange={(e) => {
              const val = parseFloat(e.target.value);
              setVolume(val);
              setIsMuted(val === 0);
              if (audioRef.current) {
                audioRef.current.volume = val;
              }
            }}
            className="volume-slider"
          />
        </div>
      </div>
    </div>
  );
}
