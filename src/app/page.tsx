'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo, useSyncExternalStore } from 'react';
import { CourseItem, ThemeType } from '@/types/course';
import { AudioProvider, useAudio } from '@/context/AudioContext';
import TreeNav from '@/components/TreeNav';
import CourseDetail from '@/components/CourseDetail';
import HomePortal from '@/components/HomePortal';
import GlobalAudioPlayer from '@/components/GlobalAudioPlayer';
import SettingsModal from '@/components/SettingsModal';
import initialDb from '@/data/courses_db.json';
import {
  DEFAULT_THEME_PREFERENCE,
  isThemePreference,
  resolveTheme,
  systemPrefersDark,
  type ThemePreference
} from '@/lib/themePreference';
import {
  saveFavorites,
  toggleFavorite,
  isFavorite,
  subscribeFavorites,
  getFavoritesSnapshot,
  getFavoritesServerSnapshot,
  type FavoriteRecord
} from '@/lib/playbackStore';
import { buildCoursePath, currentCatalogLocation } from '@/lib/catalogUrl';
import { createStringStore } from '@/lib/stringStore';
import { useServiceWorker } from '@/lib/useServiceWorker';

const THEME_STORAGE_KEY = 'fayun_theme';
const FONT_SIZE_PX_STORAGE_KEY = 'fayun_font_size_px';
const LAST_COURSE_STORAGE_KEY = 'fayun_last_selected_course_id';

const MIN_FONT_SIZE_PX = 12;
const MAX_FONT_SIZE_PX = 28;
const DEFAULT_FONT_SIZE_PX = 16;

/**
 * Browser-preference stores.
 *
 * These live at module scope so the sidebar, the settings modal and the player
 * all read the same value. Restoring them in a mount effect and then mirroring
 * them into `useState` was the pattern the hooks rules reject (a second render
 * before the first paint, and two sources of truth that could disagree); these
 * stores make storage itself the single source.
 */
const themeStore = createStringStore<ThemePreference>({
  key: THEME_STORAGE_KEY,
  fallback: DEFAULT_THEME_PREFERENCE,
  // An unknown value (hand-edited storage, or a theme removed in an upgrade)
  // falls back to the default rather than rendering `.app-root` with no palette.
  parse: (raw) => (isThemePreference(raw) ? raw : DEFAULT_THEME_PREFERENCE),
  serialize: (value) => value
});

const fontSizeStore = createStringStore<number>({
  key: FONT_SIZE_PX_STORAGE_KEY,
  fallback: DEFAULT_FONT_SIZE_PX,
  parse: (raw) => {
    const parsed = parseInt(raw, 10);
    return !isNaN(parsed) && parsed >= MIN_FONT_SIZE_PX && parsed <= MAX_FONT_SIZE_PX
      ? parsed
      : DEFAULT_FONT_SIZE_PX;
  },
  serialize: (value) =>
    String(Math.min(MAX_FONT_SIZE_PX, Math.max(MIN_FONT_SIZE_PX, Math.round(value))))
});

/**
 * Cheap "did this course actually change?" check.
 *
 * Used to keep the previously selected course object when a refreshed payload
 * is equivalent, so `CourseDetail`'s effect (which depends on the `course`
 * object) does not re-run its discovery requests for no reason. Compares by
 * value at one level, with `pdfs` compared by length plus each entry's
 * url/filename, which is what the UI actually renders. Returns false on any
 * shape difference so a genuinely changed course is never masked.
 */
function shallowEqualCourse(a: CourseItem, b: CourseItem): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  for (const key of keys) {
    if (key === 'pdfs') continue;
    if (ra[key] !== rb[key]) {
      return false;
    }
  }
  const ap = a.pdfs || [];
  const bp = b.pdfs || [];
  if (ap.length !== bp.length) return false;
  for (let i = 0; i < ap.length; i++) {
    if (ap[i]?.url !== bp[i]?.url || ap[i]?.filename !== bp[i]?.filename) return false;
  }
  return true;
}

interface MainLayoutProps {
  isMobileSidebarOpen: boolean;
  setIsMobileSidebarOpen: (open: boolean) => void;
  courses: CourseItem[];
  selectedCourse: CourseItem | null;
  handleSelectCourse: (course: CourseItem) => void;
  theme: ThemeType;
  setIsSettingsOpen: (open: boolean) => void;
  isLoading: boolean;
  error: string | null;
  isZenMode: boolean;
  setIsZenMode: React.Dispatch<React.SetStateAction<boolean>>;
  isMobileViewport: boolean;
  onGoHome: () => void;
  favorites: FavoriteRecord[];
  onToggleFavorite: (course: CourseItem) => void;
  /** Opens a course and starts the named episode at a position. */
  onResume: (course: CourseItem, filename: string, position: number) => void;
  autoPlayRequest: { filename: string; position: number } | null;
  onAutoPlayConsumed: () => void;
}

function MainLayout({
  isMobileSidebarOpen,
  setIsMobileSidebarOpen,
  courses,
  selectedCourse,
  handleSelectCourse,
  theme,
  setIsSettingsOpen,
  isLoading,
  error,
  isZenMode,
  setIsZenMode,
  isMobileViewport,
  onGoHome,
  favorites,
  onToggleFavorite,
  onResume,
  autoPlayRequest,
  onAutoPlayConsumed
}: MainLayoutProps) {
  const { currentTrack, isExpanded } = useAudio();
  const hasExpandedPlayer = Boolean(currentTrack && isExpanded);

  return (
    <div className={`layout-wrapper ${hasExpandedPlayer ? 'player-expanded' : 'player-collapsed'} ${isZenMode ? 'zen-focus-mode' : ''} ${isMobileViewport ? 'is-mobile-screen' : ''}`}>
      {/* Left Sidebar Tree Navigation */}
      <div className={`sidebar-wrapper ${isMobileSidebarOpen ? 'mobile-open' : ''}`}>
        <TreeNav
          courses={courses}
          selectedCourse={selectedCourse}
          onSelectCourse={handleSelectCourse}
          theme={theme}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onGoHome={onGoHome}
          favorites={favorites}
          onToggleFavorite={onToggleFavorite}
        />
      </div>

      {/* Mobile Backdrop Overlay */}
      {isMobileSidebarOpen && (
        <div
          className="mobile-backdrop"
          onClick={() => setIsMobileSidebarOpen(false)}
        />
      )}

      {/* Right Main Content Pane */}
      <div className="main-content-wrapper" id="main-content" tabIndex={-1}>
        {isLoading ? (
          <div className="global-loading">
            <span className="loading-spinner">🌸</span>
            <p>正在載入妙境法軒典藏數據庫...</p>
          </div>
        ) : error ? (
          <div className="global-error">
            <h3>載入錯誤</h3>
            <p>{error}</p>
          </div>
        ) : selectedCourse ? (
          <CourseDetail
            course={selectedCourse}
            isZenMode={isZenMode}
            onToggleZenMode={() => setIsZenMode((prev) => !prev)}
            onGoHome={onGoHome}
            isFavorite={isFavorite(favorites, selectedCourse.id)}
            onToggleFavorite={() => onToggleFavorite(selectedCourse)}
            autoPlayRequest={autoPlayRequest}
            onAutoPlayConsumed={onAutoPlayConsumed}
          />
        ) : (
          <HomePortal
            courses={courses}
            onSelectCourse={handleSelectCourse}
            onOpenMobileMenu={() => setIsMobileSidebarOpen(true)}
            onResume={onResume}
          />
        )}
      </div>
    </div>
  );
}

export default function Home() {
  // Registers the offline worker once the page has loaded (no-op in dev).
  const { isOfflineReady } = useServiceWorker();
  // Initialize state immediately from bundled JSON data for 0ms load time.
  // Wrapped in useMemo so its identity is stable: the bare `(x as [] ) || []`
  // expression produced a new array reference on every render, which made any
  // effect or callback depending on it re-run without anything actually
  // changing.
  const initialCourses: CourseItem[] = useMemo(
    () => (initialDb.courses as CourseItem[]) || [],
    []
  );

  const [courses, setCourses] = useState<CourseItem[]>(initialCourses);
  // Tracks whether the catalog has ever been populated, without making
  // `fetchCourses` depend on `courses`. Reading `courses.length` from the
  // callback closure made the callback's identity change whenever `setCourses`
  // ran, so the mount effect re-triggered itself (reproduced: it settled after
  // 1-2 fetches while the row count was stable, but looped while it alternated).
  const hasCoursesRef = useRef<boolean>(initialCourses.length > 0);
  const [selectedCourse, setSelectedCourse] = useState<CourseItem | null>(null);
  // The bundled catalog is available synchronously, so the view starts loaded.
  // Keep the loading flag meaningful for the refresh path instead of hardcoding
  // `false` at the end of fetchCourses (which made the loading UI unreachable).
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const themePreference = useSyncExternalStore(
    themeStore.subscribe,
    themeStore.getSnapshot,
    themeStore.getServerSnapshot
  );
  /**
   * True only when the OS reports a dark appearance; drives `system`.
   *
   * Seeded lazily rather than in the effect below. It cannot cause a hydration
   * mismatch because the default preference is `dark`, which resolves to the
   * same class whatever this value is; `system` is only ever restored from
   * storage on the client, after hydration.
   */
  const [prefersDark, setPrefersDark] = useState<boolean>(() => systemPrefersDark());
  const fontSizePx = useSyncExternalStore(
    fontSizeStore.subscribe,
    fontSizeStore.getSnapshot,
    fontSizeStore.getServerSnapshot
  );
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState<boolean>(false);
  const [isZenMode, setIsZenMode] = useState<boolean>(false);
  const [isMobileViewport, setIsMobileViewport] = useState<boolean>(false);
  const favorites = useSyncExternalStore(
    subscribeFavorites,
    getFavoritesSnapshot,
    getFavoritesServerSnapshot
  );
  /**
   * A pending request to start a specific episode once its track list loads.
   *
   * `playTrack` lives in the audio context, which is *below* this component, so
   * the request is passed down to `CourseDetail` rather than played here.
   */
  const [autoPlayRequest, setAutoPlayRequest] = useState<{ filename: string; position: number } | null>(null);

  // Auto-detect mobile viewport / user-agent across all browsers (including Firefox Mobile)
  useEffect(() => {
    const checkMobile = () => {
      const isNarrow = window.innerWidth <= 960;
      const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Firefox.*Mobile/i.test(
        navigator.userAgent
      );
      setIsMobileViewport(isNarrow || (isMobileUA && window.innerWidth <= 1024));
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // Touch gesture edge swipe to pull open/close mobile sidebar drawer
  useEffect(() => {
    let startX = 0;
    let startY = 0;
    let isEdgeSwipe = false;

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      // Start within 45px of screen left edge
      isEdgeSwipe = startX <= 45;
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (e.changedTouches.length !== 1) return;
      const endX = e.changedTouches[0].clientX;
      const endY = e.changedTouches[0].clientY;
      const deltaX = endX - startX;
      const deltaY = Math.abs(endY - startY);

      // Horizontal swipe to right from left edge -> pull open sidebar
      if (isEdgeSwipe && deltaX > 50 && deltaY < 80) {
        setIsMobileSidebarOpen(true);
      }
      // Horizontal swipe to left while sidebar is open -> pull close sidebar
      else if (isMobileSidebarOpen && deltaX < -50 && deltaY < 80) {
        setIsMobileSidebarOpen(false);
      }
    };

    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchend', handleTouchEnd);
    };
  }, [isMobileSidebarOpen]);

  // Press Escape to exit Zen focus mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isZenMode) {
        setIsZenMode(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isZenMode]);

  /**
   * Tracks the OS appearance preference.
   *
   * Kept in state (not read once on mount) so choosing "跟隨系統" follows a
   * sunset switch live instead of being frozen at the value seen on load.
   */
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;

    let media: MediaQueryList;
    try {
      media = window.matchMedia('(prefers-color-scheme: dark)');
    } catch {
      return;
    }
    const handleChange = (e: MediaQueryListEvent) => setPrefersDark(e.matches);
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', handleChange);
      return () => media.removeEventListener('change', handleChange);
    }
    // Safari < 14 only exposes the deprecated listener API.
    media.addListener(handleChange);
    return () => media.removeListener(handleChange);
  }, []);

  // Resolved during render rather than in an effect: the applied theme is a
  // pure function of the preference and the OS setting, so deriving it keeps
  // the class in the same commit as the state that changed it (an effect would
  // paint one frame with the previous palette).
  const theme: ThemeType = resolveTheme(themePreference, prefersDark);

  // Restore saved theme, font size & last selected/played course from localStorage on mount
  useEffect(() => {
    try {
      // Theme, font size and favorites are read through their stores, so they
      // need no restore step here; only the selection remains.

      // The URL wins over the stored course: a shared link or a bookmark must
      // open the course it names, not whatever was studied last.
      const fromUrl = currentCatalogLocation();
      const savedCourseIdStr = localStorage.getItem(LAST_COURSE_STORAGE_KEY);
      const savedTrackStr = localStorage.getItem('fayun_last_played_track');

      let targetId: number | null = null;
      if (fromUrl.courseId !== null) {
        targetId = fromUrl.courseId;
      } else if (savedCourseIdStr) {
        targetId = parseInt(savedCourseIdStr, 10);
      } else if (savedTrackStr) {
        try {
          const parsedTrack = JSON.parse(savedTrackStr);
          if (parsedTrack?.currentTrack?.courseId) {
            targetId = parsedTrack.currentTrack.courseId;
          }
        } catch {}
      }

      if (targetId && !isNaN(targetId)) {
        const restoredCourse = initialCourses.find((c) => c.id === targetId);
        if (restoredCourse) {
          // Deliberately a state write in an effect. The stored selection is an
          // external system (the URL and localStorage) and cannot be read during
          // render without desynchronising SSR from the first client paint, so
          // this is React's documented "subscribe to an external system" case
          // rather than a render-phase cascade. `initialCourses` is memoised, so
          // this runs exactly once.
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setSelectedCourse(restoredCourse);
        }
      }
    } catch (e) {
      console.warn('Failed to restore settings from localStorage:', e);
    }
  }, [initialCourses]);

  /**
   * Adds/removes a course from the favorites list.
   *
   * Written through the shared store so the sidebar chips, the course header
   * star and the persisted record can never disagree about what is favorited.
   */
  const handleToggleFavorite = useCallback((course: CourseItem) => {
    const next = toggleFavorite(getFavoritesSnapshot(), course.id, course.name);
    saveFavorites(next);
  }, []);

  const handleSelectTheme = (newTheme: ThemePreference) => {
    themeStore.set(newTheme);
  };

  const handleSelectFontSizePx = (newPx: number) => {
    fontSizeStore.set(newPx);
  };

  /**
   * Responds to Back/Forward.
   *
   * A history traversal changes the address bar without going through
   * `handleSelectCourse`, so the selection has to be re-derived from the URL or
   * the page and the address bar disagree after a Back press.
   */
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handlePopState = () => {
      const location = currentCatalogLocation();
      if (location.courseId === null) {
        setSelectedCourse(null);
        return;
      }
      // The catalog may not have loaded yet on a cold Back into a deep link, so
      // the row is resolved from whatever list the page currently holds.
      const match = courses.find((c) => c.id === location.courseId);
      if (match) setSelectedCourse(match);
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [courses]);

  const fetchCourses = useCallback(async () => {
    try {
      // Only show the spinner when there is genuinely nothing to render yet.
      // The bundled catalog is available synchronously, so a first-paint load
      // flashed "正在載入..." over a page that was already complete (visible as
      // home -> spinner -> home). A refresh with data on screen stays silent;
      // the fetched rows simply replace the bundled ones.
      if (!hasCoursesRef.current) setIsLoading(true);
      setError(null);
      // Revalidate rather than bust. The route answers with an ETag and
      // `no-cache`, so `cache: 'no-cache'` sends If-None-Match and an unchanged
      // ~900 KB catalog comes back as an empty 304. The old `?t=${Date.now()}`
      // made every URL unique, so the 304 path could never be reached.
      const res = await fetch('/api/courses', {
        cache: 'no-cache'
      });
      if (!res.ok) {
        throw new Error(`HTTP error ${res.status}`);
      }
      const data: unknown = await res.json();
      // Validate at the boundary. The payload comes from the network and was
      // previously cast straight to CourseItem[]; a single row missing `name`
      // then crashed the tree builder (`course.name.toLowerCase()`) and the
      // home portal (`c.name.includes(...)`), blanking the whole UI instead of
      // skipping one bad row.
      const rawList: unknown[] = Array.isArray((data as { courses?: unknown })?.courses)
        ? ((data as { courses: unknown[] }).courses)
        : [];
      const isCourseRow = (c: unknown): c is CourseItem => {
        if (!c || typeof c !== 'object') return false;
        const row = c as Record<string, unknown>;
        return (
          typeof row.id === 'number' &&
          Number.isFinite(row.id) &&
          typeof row.name === 'string'
        );
      };
      const courseList = rawList.filter(isCourseRow);
      if (rawList.length > 0 && courseList.length === 0) {
        setError('伺服器回傳的課程資料格式不正確');
      } else if (courseList.length > 0) {
        setCourses(courseList);
        hasCoursesRef.current = true;
        setSelectedCourse((prevSelected) => {
          if (prevSelected) {
            // Reuse the previous object when the refreshed row is unchanged.
            // `courseList` always contains freshly parsed objects, so returning
            // the new one unconditionally gave CourseDetail a new `course`
            // identity on every refresh (and on every /api/scan completion),
            // re-triggering its three discovery routines — 7-13 upstream
            // directory probes — even though nothing about the course changed.
            const updated = courseList.find((c) => c.id === prevSelected.id);
            if (!updated) return prevSelected;
            return shallowEqualCourse(prevSelected, updated) ? prevSelected : updated;
          }
          return null;
        });
        setError(null);
      } else {
        setError('伺服器回傳的課程清單為空');
      }
    } catch (err: unknown) {
      // Fall back to the bundled catalog, but surface the failure so the user
      // is not silently shown stale data. The initial state already holds the
      // bundled DB, so the UI remains usable.
      console.warn('Failed to refresh courses from API, using bundled DB:', err);
      if (!hasCoursesRef.current) {
        setError(err instanceof Error ? err.message : '無法載入課程資料庫');
      }
    } finally {
      setIsLoading(false);
    }
    // Intentionally empty deps. Reading `courses.length` from the closure here
    // made this callback's identity depend on the course list, which
    // `setCourses` above mutates — so the mount effect below re-triggered
    // itself, refetching (and re-rendering the 684-row tree) whenever the
    // server row count differed from the local one. Reproduced: it settled
    // after 1-2 fetches while the count was stable but looped (never settling)
    // while the count alternated. The ref breaks that cycle.
  }, []);

  // Initial catalog refresh. The bundled catalog is already rendered, so this
  // only reconciles it with the server.
  //
  // The lint rule cannot see through the call: `fetchCourses` does contain a
  // `setIsLoading(true)`, but it is behind `if (!hasCoursesRef.current)`, which
  // is false on mount because the bundled catalog is present. The only state
  // write that can happen here is the one after the network round-trip.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchCourses();
  }, [fetchCourses]);

  const handleSelectCourse = (course: CourseItem) => {
    setSelectedCourse(course);
    setIsMobileSidebarOpen(false);
    try {
      localStorage.setItem(LAST_COURSE_STORAGE_KEY, String(course.id));
    } catch (e) {
      console.warn('Failed to save last course ID to localStorage:', e);
    }
    pushCatalogUrl(course.id);
  };

  /**
   * Writes the selection into the address bar.
   *
   * `pushState` rather than the router: navigating through the App Router would
   * re-render this page component, remount `AudioProvider`, and stop playback.
   * The History entry is what makes the URL shareable and the Back button work.
   */
  const pushCatalogUrl = useCallback((courseId: number | null, episode?: number | null) => {
    if (typeof window === 'undefined') return;
    const next = buildCoursePath(courseId, episode);
    if (window.location.pathname + window.location.search === next) return;
    window.history.pushState({ courseId }, '', next);
  }, []);

  /**
   * Opens the course that owns a stored position and asks it to start there.
   *
   * Selecting the course and queueing the episode are separate steps because
   * the episode list does not exist until `CourseDetail` has discovered it.
   */
  const handleResumeFromHome = useCallback(
    (course: CourseItem, filename: string, position: number) => {
      setSelectedCourse(course);
      setIsMobileSidebarOpen(false);
      setAutoPlayRequest({ filename, position });
      try {
        localStorage.setItem(LAST_COURSE_STORAGE_KEY, String(course.id));
      } catch {}
    },
    []
  );

  const handleGoHome = useCallback(() => {
    setSelectedCourse(null);
    setIsMobileSidebarOpen(false);
    setIsZenMode(false);
    if (typeof window !== 'undefined' && window.location.pathname !== '/') {
      window.history.pushState({ courseId: null }, '', '/');
    }
    try {
      localStorage.removeItem(LAST_COURSE_STORAGE_KEY);
    } catch (e) {
      console.warn('Failed to clear last course in localStorage:', e);
    }
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      const mainEl = document.querySelector('.main-content-wrapper');
      if (mainEl) {
        mainEl.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }
  }, []);

  return (
    <AudioProvider>
      <div
        className={`app-root ${theme} ${isZenMode ? 'zen-mode-root' : ''} ${isMobileViewport ? 'is-mobile-screen' : ''}`}
        style={
          {
            '--base-font-size': `${fontSizePx}px`,
            fontSize: `${fontSizePx}px`
          } as React.CSSProperties
        }
      >
        {/* Keyboard users otherwise tab through the 684-row course tree before
            reaching the content; this jumps straight to the main pane. */}
        <a href="#main-content" className="skip-to-content">
          跳至主要內容
        </a>

        {/* Mobile Top Navbar */}
        <div className="mobile-navbar">
          <button
            className="mobile-menu-btn"
            onClick={() => setIsMobileSidebarOpen(!isMobileSidebarOpen)}
          >
            ☰ 目錄選單
          </button>
          <span
            className="mobile-title clickable"
            onClick={handleGoHome}
            role="button"
            tabIndex={0}
            title="點擊回到妙境法軒首頁"
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleGoHome();
              }
            }}
          >
            妙境法軒
          </span>
          {isOfflineReady && (
            <span className="offline-ready-badge" title="已啟用離線快取：聽過的講記可在無網路時重聽">
              離線
            </span>
          )}
          <button
            className="settings-open-btn mobile-settings-btn"
            onClick={() => setIsSettingsOpen(true)}
            title="開啟系統與字體設定面板"
          >
            ⚙️ 設定
          </button>
        </div>

        <MainLayout
          isMobileSidebarOpen={isMobileSidebarOpen}
          setIsMobileSidebarOpen={setIsMobileSidebarOpen}
          courses={courses}
          selectedCourse={selectedCourse}
          handleSelectCourse={handleSelectCourse}
          theme={theme}
          setIsSettingsOpen={setIsSettingsOpen}
          isLoading={isLoading}
          error={error}
          isZenMode={isZenMode}
          setIsZenMode={setIsZenMode}
          isMobileViewport={isMobileViewport}
          onGoHome={handleGoHome}
          favorites={favorites}
          onToggleFavorite={handleToggleFavorite}
          onResume={handleResumeFromHome}
          autoPlayRequest={autoPlayRequest}
          onAutoPlayConsumed={() => setAutoPlayRequest(null)}
        />

        {/* Settings Modal Panel */}
        <SettingsModal
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          theme={theme}
          onSelectTheme={handleSelectTheme}
          fontSizePx={fontSizePx}
          onSelectFontSize={handleSelectFontSizePx}
          onRefreshCourses={fetchCourses}
        />

        {/* Global Floating Audio Player */}
        <GlobalAudioPlayer />
      </div>
    </AudioProvider>
  );
}
