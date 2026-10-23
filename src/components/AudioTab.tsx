'use client';

import React from 'react';

import type { AudioTrackInfo } from '@/lib/courseMedia';
import ListErrorState from './ListErrorState';

interface AudioTabProps {
  tracks: AudioTrackInfo[];
  /** Tracks remaining after the volume filter and the search box. */
  filteredTracks: AudioTrackInfo[];
  /** The subset of `filteredTracks` currently in the DOM (batched). */
  visibleTracks: AudioTrackInfo[];
  availableVolumes: string[];
  selectedVolume: string;
  onSelectVolume: (volume: string) => void;
  episodeSearch: string;
  onSearchChange: (value: string) => void;
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
  /** Filename of the episode currently loaded in the player, if any. */
  currentFilename: string | null;
  isPlaying: boolean;
  onPlay: (track: AudioTrackInfo) => void;
  hasMore: boolean;
  onLoadMore: () => void;
  loadMoreRef: React.RefObject<HTMLLIElement | null>;
}

/**
 * The 音訊錄音 tab: search, volume filter, and the batched episode list.
 *
 * Extracted from `CourseDetail`, which had grown to 1,500 lines covering every
 * tab plus all three discovery fetches.
 */
export default function AudioTab({
  tracks,
  filteredTracks,
  visibleTracks,
  availableVolumes,
  selectedVolume,
  onSelectVolume,
  episodeSearch,
  onSearchChange,
  isLoading,
  error,
  onRetry,
  currentFilename,
  isPlaying,
  onPlay,
  hasMore,
  onLoadMore,
  loadMoreRef
}: AudioTabProps) {
  return (
    <div className="audio-tab-content">
      <div className="track-list-toolbar">
        <div className="toolbar-search-wrapper">
          <input
            type="text"
            placeholder="🔍 搜尋單集檔名、卷次或集數..."
            value={episodeSearch}
            onChange={(e) => onSearchChange(e.target.value)}
            className="episode-search-input"
            aria-label="搜尋單集"
          />
          {episodeSearch && (
            <button
              className="search-clear-btn"
              onClick={() => onSearchChange('')}
              title="清除搜尋"
              aria-label="清除搜尋"
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
              onChange={(e) => onSelectVolume(e.target.value)}
              className="volume-dropdown"
              aria-label="依卷次篩選"
            >
              <option value="all">全部卷次（共 {tracks.length} 講）</option>
              {availableVolumes.map((vol) => {
                const count = tracks.filter((t) => t.volume === vol).length;
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
          顯示 {filteredTracks.length} / {tracks.length} 集
        </span>
      </div>

      {isLoading ? (
        <div className="loading-state">
          <span className="loading-spinner">🌸</span>
          <p>正在載入音訊清單...</p>
        </div>
      ) : error ? (
        <ListErrorState message={error} onRetry={onRetry} />
      ) : tracks.length === 0 ? (
        <div className="no-audio-state">
          <p>尚無線上記錄之音訊檔案，或正在數據庫同步中</p>
        </div>
      ) : (
        <ul className="episodes-list">
          {visibleTracks.map((track) => {
            const isCurrentlyPlayingTrack = currentFilename === (track.displayName || track.filename);

            return (
              <li
                key={track.index}
                className={`episode-item ${isCurrentlyPlayingTrack ? 'playing' : ''}`}
                onClick={() => onPlay(track)}
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
                    <button
                      className="play-track-btn"
                      aria-label={`播放第 ${track.index + 1} 集：${track.filename}`}
                    >
                      ▶ 播放
                    </button>
                  )}
                  <a
                    href={track.proxyUrl}
                    download={track.filename}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="download-track-link"
                    title="下載 MP3/M4A 音訊"
                    aria-label={`下載第 ${track.index + 1} 集：${track.filename}`}
                  >
                    ⬇ 下載
                  </a>
                </div>
              </li>
            );
          })}
          {hasMore && (
            <li className="episodes-load-more" ref={loadMoreRef}>
              <button
                type="button"
                className="load-more-btn"
                onClick={onLoadMore}
                aria-label={`載入更多集數，目前顯示 ${visibleTracks.length} / ${filteredTracks.length}`}
              >
                載入更多（已顯示 {visibleTracks.length} / {filteredTracks.length}）
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
