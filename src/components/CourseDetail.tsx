'use client';

import React, { useState, useEffect, useRef, useMemo, useCallback, useSyncExternalStore } from 'react';
import { CourseItem } from '@/types/course';
import { useAudio } from '@/context/AudioContext';
import { getKeyedStringStore } from '@/lib/stringStore';
import { useAudioTracks } from '@/lib/useAudioTracks';
import { useVideoTracks } from '@/lib/useVideoTracks';
import { usePdfTracks } from '@/lib/usePdfTracks';
import { EPISODE_BATCH_SIZE } from '@/lib/courseMedia';
import VideoPlayer from './VideoPlayer';
import PdfViewer from './PdfViewer';
import ListErrorState from './ListErrorState';
import AudioTab from './AudioTab';

interface CourseDetailProps {
  course: CourseItem;
  isZenMode?: boolean;
  onToggleZenMode?: () => void;
  onGoHome?: () => void;
  /** Whether this course is in the reader's favorites list. */
  isFavorite?: boolean;
  onToggleFavorite?: () => void;
  /**
   * Episode to start as soon as the audio list resolves, with its position.
   *
   * Used by the home page's "continue listening" card and by a deep link that
   * names an episode: the track list is discovered asynchronously, so the
   * request has to survive until the list exists.
   */
  autoPlayRequest?: { filename: string; position: number } | null;
  /** Called once the request has been honoured, so it is not replayed. */
  onAutoPlayConsumed?: () => void;
}

const MIN_SPLIT_RATIO = 25;
const MAX_SPLIT_RATIO = 75;
const DEFAULT_SPLIT_RATIO = 50;

const splitRatioStore = getKeyedStringStore<number>({
  key: 'fayun_split_ratio',
  fallback: DEFAULT_SPLIT_RATIO,
  parse: (raw) => {
    const val = parseFloat(raw);
    return !isNaN(val) && val >= MIN_SPLIT_RATIO && val <= MAX_SPLIT_RATIO
      ? val
      : DEFAULT_SPLIT_RATIO;
  },
  serialize: (value) =>
    String(Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, value)))
});

/**
 * Per-course tab and video-position stores.
 *
 * The key includes the course id because the stored preference is
 * per-course (`fayun_last_tab_<id>`); the factory caches by key, so the
 * snapshot identity stays stable while the same course is open.
 */
const tabStoreFor = (courseId: number) =>
  getKeyedStringStore<ActiveTab>({
    key: `fayun_last_tab_${courseId}`,
    fallback: 'audio',
    parse: (raw) => (isActiveTab(raw) ? raw : 'audio'),
    serialize: (value) => value
  });

const videoIndexStoreFor = (courseId: number) =>
  getKeyedStringStore<number>({
    key: `fayun_last_video_idx_${courseId}`,
    fallback: 0,
    parse: (raw) => {
      const parsed = parseInt(raw, 10);
      return !isNaN(parsed) && parsed >= 0 ? parsed : 0;
    },
    serialize: (value) => String(Math.max(0, Math.floor(value)))
  });

/** Tabs the detail pane can show; also used to validate the stored value. */
type ActiveTab = 'audio' | 'video' | 'pdf' | 'info' | 'split';

const ACTIVE_TABS: readonly ActiveTab[] = ['audio', 'video', 'pdf', 'info', 'split'];

/**
 * Validates a value read back from localStorage.
 *
 * The stored tab is user-writable and survives upgrades, so it is narrowed
 * rather than cast: a stale or hand-edited value previously went through
 * `as any` and put an unknown string into state.
 */
function isActiveTab(value: unknown): value is ActiveTab {
  return typeof value === 'string' && (ACTIVE_TABS as readonly string[]).includes(value);
}


export default function CourseDetail({
  course,
  isZenMode,
  onToggleZenMode,
  onGoHome,
  isFavorite,
  onToggleFavorite,
  autoPlayRequest,
  onAutoPlayConsumed
}: CourseDetailProps) {
  const { currentTrack, isPlaying, playTrack, togglePlay } = useAudio();


  const [selectedVolume, setSelectedVolume] = useState<string>('all');
  const [episodeSearch, setEpisodeSearch] = useState<string>('');

  /**
   * Bumped by the retry buttons to re-run discovery.
   *
   * The hooks depend on `course`, so re-running them needs a dependency that
   * changes without the course itself changing.
   */
  const [reloadToken, setReloadToken] = useState<number>(0);
  const retryLoad = () => setReloadToken((n) => n + 1);

  // Discovery for the three lists lives in its own hooks; each owns its own
  // loading and failure state so a broken video listing cannot mask the audio
  // list's status.
  const { tracks: audioTracks, availableVolumes, isLoading: isLoadingAudio, error: audioError } =
    useAudioTracks(course, reloadToken);
  const { tracks: videoTracks, isLoading: isLoadingVideo, error: videoError } =
    useVideoTracks(course, reloadToken);
  const { tracks: pdfTracks, isLoading: isLoadingPdf, error: pdfError } =
    usePdfTracks(course, reloadToken);

  // Draggable Split-Screen Ratio
  /**
   * Reader-adjusted split-pane width, persisted across visits.
   *
   * Held in a module-level store rather than restored by a mount effect: the
   * pane must not paint at the default width and then jump, and writing state
   * from an effect is the pattern the hooks rules reject.
   */
  const splitRatio = useSyncExternalStore(
    splitRatioStore.subscribe,
    splitRatioStore.getSnapshot,
    splitRatioStore.getServerSnapshot
  );
  const setSplitRatio = (value: number) => splitRatioStore.set(value);
  const splitContainerRef = useRef<HTMLDivElement | null>(null);

  // Drag listeners are registered on window; keep handles so an unmount in the
  // middle of a drag (e.g. switching course) cannot leave them attached.
  const splitDragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      splitDragCleanupRef.current?.();
      splitDragCleanupRef.current = null;
    };
  }, []);

  const handleSplitMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const container = splitContainerRef.current;
    if (!container) return;

    // Replace any previous drag session instead of stacking listeners.
    splitDragCleanupRef.current?.();

    let frame = 0;
    let pendingRatio = splitRatio;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      if (rect.width === 0) return;
      pendingRatio = Math.max(25, Math.min(75, ((moveEvent.clientX - rect.left) / rect.width) * 100));
      // Coalesce mousemove into one state update per animation frame.
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setSplitRatio(pendingRatio);
      });
    };

    const handleMouseUp = () => {
      splitDragCleanupRef.current?.();
      splitDragCleanupRef.current = null;
      // Through the store, so subscribers update and the write is not a second
      // path to a key the store already owns.
      splitRatioStore.set(Number(pendingRatio.toFixed(1)));
    };

    const cleanup = () => {
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    splitDragCleanupRef.current = cleanup;
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };


  const hasVideo = Boolean(course.video_path || (course.name && course.name.includes('本地分')));

  // Reset the tab during render when the course changes.
  //
  /**
   * Per-course tab and video position, restored from storage.
   *
   * These are read during render from keyed stores instead of being pushed into
   * state by a mount effect. The old effect had two problems it could not solve:
   * it ran after the first paint (so the previous course's tab showed for one
   * frame), and it wrote state on every mount/course change, which is the
   * cascading-render pattern the hooks rules reject.
   *
   * The manual override below is tagged with the course it belongs to, so the
   * stored value wins again as soon as a different course is opened.
   */
  const tabOverride = useSyncExternalStore(
    tabStoreFor(course.id).subscribe,
    tabStoreFor(course.id).getSnapshot,
    tabStoreFor(course.id).getServerSnapshot
  );

  // A stored `video`/`split` tab is not reachable for a course with no video, so
  // it falls back to the audio tab rather than rendering an empty pane.
  const activeTab: ActiveTab =
    (tabOverride === 'video' || tabOverride === 'split') && !hasVideo ? 'audio' : tabOverride;

  const setActiveTab = (tab: ActiveTab) => {
    tabStoreFor(course.id).set(tab);
  };

  const savedVideoIndex = useSyncExternalStore(
    videoIndexStoreFor(course.id).subscribe,
    videoIndexStoreFor(course.id).getSnapshot,
    videoIndexStoreFor(course.id).getServerSnapshot
  );

  // Seeded from the stored value once per course, then owned by the component.
  const [currentVideoIndex, setCurrentVideoIndex] = useState<number>(savedVideoIndex);
  const [videoIndexCourseId, setVideoIndexCourseId] = useState<number>(course.id);
  if (videoIndexCourseId !== course.id) {
    setVideoIndexCourseId(course.id);
    setCurrentVideoIndex(savedVideoIndex);
  }

  /**
   * Persists the video position for this course.
   *
   * A write to storage, not a state update, so it belongs in an effect: doing it
   * inside the render-phase clamp below would touch `localStorage` and notify
   * subscribers while rendering, which is not allowed.
   */
  useEffect(() => {
    videoIndexStoreFor(course.id).set(currentVideoIndex);
  }, [course.id, currentVideoIndex]);

  const handleVideoIndexChange = (idx: number) => {
    setCurrentVideoIndex(idx);
  };

  // The index actually handed to VideoPlayer. Guards both the lookup it does
  // (`tracks[currentTrackIndex]`) and its "第 N / M 集" label against a stale
  // saved index, for the frames before the clamp below has run. The stored value
  // itself is left untouched so persistence still round-trips.
  const safeVideoIndex =
    videoTracks.length > 0 && currentVideoIndex >= videoTracks.length ? 0 : currentVideoIndex;

  // Clamp the restored video index against the discovered list.
  //
  // The restore above runs while `videoTracks` is still empty, so an index that
  // was valid when it was saved can outlive the list it was saved against: a
  // renumbered/auto-healed listing, one of the discovery-dependent 本地分
  // volumes, or a shrunk /api/list-files result. VideoPlayer resolves
  // `tracks[currentTrackIndex]`, so an out-of-range index made it bail out and
  // the whole pane rendered blank — no video, no nav, no empty state.
  //
  // Adjusted during render (the same idiom as the tab reset above) so the very
  // first commit that has a non-empty list already shows episode 1. An empty
  // list is deliberately not clamped: the saved index is kept so a transient
  // discovery failure can still restore the episode the user was watching.
  const [videoListLength, setVideoListLength] = useState<number>(videoTracks.length);
  if (videoListLength !== videoTracks.length) {
    setVideoListLength(videoTracks.length);
    if (videoTracks.length > 0 && currentVideoIndex >= videoTracks.length) {
      // Also resets the stored index: leaving a now-invalid value in storage
      // made the clamp re-run on every future visit for this course.
      handleVideoIndexChange(0);
    }
  }

  const handleTabClick = (tab: 'audio' | 'video' | 'pdf' | 'info' | 'split') => {
    if ((tab === 'video' || tab === 'split') && !hasVideo) {
      return;
    }
    if (tab === 'video' && isPlaying) {
      togglePlay();
    }
    // The store persists and notifies subscribers; no separate localStorage
    // write here, which would be a second path to the same key.
    setActiveTab(tab);
  };

  const handleVideoSelect = (idx: number) => {
    if (idx >= 0 && idx < videoTracks.length) {
      // The persistence effect watches `currentVideoIndex` and writes it, so no
      // direct storage write here.
      handleVideoIndexChange(idx);
      if (isPlaying) {
        togglePlay();
      }
    }
  };

  // Reset the volume filter and the episode search when the course changes.
  //
  // Done during render (the same idiom as the tab reset above) so the first
  // commit for the new course already shows the unfiltered list instead of
  // briefly applying the previous course's volume, which matched nothing and
  // rendered an empty episode list for one frame.
  const [filtersCourseId, setFiltersCourseId] = useState<number>(course.id);
  if (filtersCourseId !== course.id) {
    setFiltersCourseId(course.id);
    setSelectedVolume('all');
    // No need to clear the volume list here: `useAudioTracks` resets both the
    // tracks and the volume list when the course changes.
    setEpisodeSearch('');
  }

  /**
   * Honours a pending "start this episode" request.
   *
   * The track list is discovered asynchronously, so the request can arrive
   * before there is anything to play. This waits for both the list and the
   * request, matches by filename (the URL carries the episode's identity, not
   * its position, since the list order is not guaranteed), and only then
   * consumes the request — a failed match leaves it pending rather than
   * silently dropping the user somewhere else.
   */
  useEffect(() => {
    if (!autoPlayRequest || audioTracks.length === 0) return;

    const target =
      audioTracks.find((t) => (t.displayName || t.filename) === autoPlayRequest.filename) ||
      audioTracks.find((t) => t.filename === autoPlayRequest.filename) ||
      audioTracks.find((t) => t.filename.includes(autoPlayRequest.filename));
    if (!target) return;

    playTrack(
      course.name,
      course.id,
      audioTracks.map((t) => ({
        filename: t.displayName || t.filename,
        url: t.url,
        proxyUrl: t.proxyUrl,
        index: t.index
      })),
      target.index,
      autoPlayRequest.position
    );
    onAutoPlayConsumed?.();
  }, [autoPlayRequest, audioTracks, course.name, course.id, playTrack, onAutoPlayConsumed]);

  const filteredAudioTracks = useMemo(() => audioTracks.filter((t) => {
    const matchVol = selectedVolume === 'all' || t.volume === selectedVolume;
    const q = episodeSearch.trim().toLowerCase();
    const matchSearch = q
      ? (t.filename.toLowerCase().includes(q) ||
         (t.displayName && t.displayName.toLowerCase().includes(q)) ||
         (t.volume && t.volume.toLowerCase().includes(q)))
      : true;
    return matchVol && matchSearch;
  }), [audioTracks, selectedVolume, episodeSearch]);

  /**
   * How many episodes are in the DOM.
   *
   * 瑜伽師地論 has 969 episodes. Rendering them all produced 7,945 DOM nodes and
   * 986 buttons in one commit, which made scrolling stutter on mid-range phones
   * and re-rendered the whole list on every keystroke in the episode search.
   * Batches of 100 keep the first paint cheap and grow on demand.
   */
  const [visibleCount, setVisibleCount] = useState<number>(EPISODE_BATCH_SIZE);

  // A new filter (or a new course) starts again from the first batch.
  const [batchedFor, setBatchedFor] = useState<string>(`${course.id}::${selectedVolume}::${episodeSearch}`);
  if (batchedFor !== `${course.id}::${selectedVolume}::${episodeSearch}`) {
    setBatchedFor(`${course.id}::${selectedVolume}::${episodeSearch}`);
    setVisibleCount(EPISODE_BATCH_SIZE);
  }

  const visibleAudioTracks = visibleCount >= filteredAudioTracks.length
    ? filteredAudioTracks
    : filteredAudioTracks.slice(0, visibleCount);
  const hasMoreEpisodes = visibleCount < filteredAudioTracks.length;

  const loadMoreRef = useRef<HTMLLIElement | null>(null);
  const loadMore = useCallback(() => {
    setVisibleCount((n) => n + EPISODE_BATCH_SIZE);
  }, []);

  // Grow the list as the sentinel scrolls into view, so the reader never has to
  // press anything; the button stays for keyboard users, who cannot scroll a
  // sentinel into view.
  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node || !hasMoreEpisodes) return;
    if (typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      // Start a screen early so the next batch is ready before it is reached.
      { rootMargin: '600px 0px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMoreEpisodes, loadMore, visibleCount]);

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
              title="點擊回到妙境法軒首頁"
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onGoHome?.();
                }
              }}
            >
              妙境法軒
            </span>
            <span>/</span>
            <span>{course.main_menu_title}</span>
            <span>/</span>
            <span>{course.sub_menu_title}</span>
            <span>/</span>
            <span className="current">{course.name}</span>
          </div>

          <div className="course-header-actions">
            {onToggleFavorite && (
              <button
                className={`course-favorite-btn ${isFavorite ? 'active' : ''}`}
                onClick={onToggleFavorite}
                title={isFavorite ? '從「我的收藏」移除本課程' : '加入「我的收藏」快速回訪'}
                aria-pressed={Boolean(isFavorite)}
              >
                {isFavorite ? '★ 已收藏' : '☆ 收藏'}
              </button>
            )}
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
              {/* Distinguish "still loading" from "loaded with 0 results": the
                  old `length || '載入中'` labelled a finished-but-empty list as
                  loading forever (e.g. after an upstream 502). */}
              🎬 影音講記 ({isLoadingVideo ? '載入中' : videoTracks.length})
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
            <AudioTab
              tracks={audioTracks}
              filteredTracks={filteredAudioTracks}
              visibleTracks={visibleAudioTracks}
              availableVolumes={availableVolumes}
              selectedVolume={selectedVolume}
              onSelectVolume={setSelectedVolume}
              episodeSearch={episodeSearch}
              onSearchChange={setEpisodeSearch}
              isLoading={isLoadingAudio}
              error={audioError}
              onRetry={retryLoad}
              currentFilename={
                currentTrack?.courseId === course.id ? currentTrack.filename : null
              }
              isPlaying={isPlaying}
              onPlay={(track) =>
                playTrack(
                  course.name,
                  course.id,
                  audioTracks.map((t) => ({
                    filename: t.displayName || t.filename,
                    url: t.url,
                    proxyUrl: t.proxyUrl,
                    index: t.index
                  })),
                  track.index
                )
              }
              hasMore={hasMoreEpisodes}
              onLoadMore={loadMore}
              loadMoreRef={loadMoreRef}
            />
          )}

          {/* 2. Video Player Tab */}
          {activeTab === 'video' && (
            <div className="video-tab-content">
              {isLoadingVideo ? (
                <div className="loading-state">
                  <span className="loading-spinner">🎬</span>
                  <p>正在載入影音講記清單...</p>
                </div>
              ) : videoError ? (
                <ListErrorState message={videoError} onRetry={retryLoad} />
              ) : (
                <VideoPlayer
                  tracks={videoTracks}
                  currentTrackIndex={safeVideoIndex}
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
              ) : pdfError ? (
                <ListErrorState message={pdfError} onRetry={retryLoad} />
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
                  currentTrackIndex={safeVideoIndex}
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
