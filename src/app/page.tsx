'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { CourseItem, ThemeType } from '@/types/course';
import { AudioProvider, useAudio } from '@/context/AudioContext';
import TreeNav from '@/components/TreeNav';
import CourseDetail from '@/components/CourseDetail';
import HomePortal from '@/components/HomePortal';
import GlobalAudioPlayer from '@/components/GlobalAudioPlayer';
import SettingsModal from '@/components/SettingsModal';
import initialDb from '@/data/courses_db.json';

const THEME_STORAGE_KEY = 'fayun_theme';
const FONT_SIZE_PX_STORAGE_KEY = 'fayun_font_size_px';
const LAST_COURSE_STORAGE_KEY = 'fayun_last_selected_course_id';

interface MainLayoutProps {
  isMobileSidebarOpen: boolean;
  setIsMobileSidebarOpen: (open: boolean) => void;
  courses: CourseItem[];
  selectedCourse: CourseItem | null;
  handleSelectCourse: (course: CourseItem) => void;
  fetchCourses: () => Promise<void>;
  theme: ThemeType;
  handleSelectTheme: (theme: ThemeType) => void;
  setIsSettingsOpen: (open: boolean) => void;
  isLoading: boolean;
  error: string | null;
  isZenMode: boolean;
  setIsZenMode: React.Dispatch<React.SetStateAction<boolean>>;
  isMobileViewport: boolean;
  onGoHome: () => void;
}

function MainLayout({
  isMobileSidebarOpen,
  setIsMobileSidebarOpen,
  courses,
  selectedCourse,
  handleSelectCourse,
  fetchCourses,
  theme,
  handleSelectTheme,
  setIsSettingsOpen,
  isLoading,
  error,
  isZenMode,
  setIsZenMode,
  isMobileViewport,
  onGoHome
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
          onRefreshCourses={fetchCourses}
          theme={theme}
          onSelectTheme={handleSelectTheme}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onGoHome={onGoHome}
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
      <div className="main-content-wrapper">
        {isLoading ? (
          <div className="global-loading">
            <span className="loading-spinner">🌸</span>
            <p>正在載入法雲資訊網典藏數據庫...</p>
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
          />
        ) : (
          <HomePortal
            courses={courses}
            onSelectCourse={handleSelectCourse}
            onOpenMobileMenu={() => setIsMobileSidebarOpen(true)}
          />
        )}
      </div>
    </div>
  );
}

export default function Home() {
  // Initialize state immediately from bundled JSON data for 0ms load time
  const initialCourses: CourseItem[] = (initialDb.courses as CourseItem[]) || [];

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

  const [theme, setTheme] = useState<ThemeType>('dark');
  const [fontSizePx, setFontSizePx] = useState<number>(16);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState<boolean>(false);
  const [isZenMode, setIsZenMode] = useState<boolean>(false);
  const [isMobileViewport, setIsMobileViewport] = useState<boolean>(false);

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

  // Restore saved theme, font size & last selected/played course from localStorage on mount
  useEffect(() => {
    try {
      const savedTheme = localStorage.getItem(THEME_STORAGE_KEY) as ThemeType | null;
      if (savedTheme && ['dark', 'light', 'pine', 'sandalwood', 'zen', 'gruvbox'].includes(savedTheme)) {
        setTheme(savedTheme);
      }

      const savedPxStr = localStorage.getItem(FONT_SIZE_PX_STORAGE_KEY);
      if (savedPxStr) {
        const parsedPx = parseInt(savedPxStr, 10);
        if (!isNaN(parsedPx) && parsedPx >= 12 && parsedPx <= 28) {
          setFontSizePx(parsedPx);
        }
      }

      // Restore last course ID or last played audio track's course ID
      const savedCourseIdStr = localStorage.getItem(LAST_COURSE_STORAGE_KEY);
      const savedTrackStr = localStorage.getItem('fayun_last_played_track');

      let targetId: number | null = null;
      if (savedCourseIdStr) {
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
          setSelectedCourse(restoredCourse);
        }
      }
    } catch (e) {
      console.warn('Failed to restore settings from localStorage:', e);
    }
  }, [initialCourses]);

  const handleSelectTheme = (newTheme: ThemeType) => {
    setTheme(newTheme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, newTheme);
    } catch (e) {
      console.warn('Failed to save theme to localStorage:', e);
    }
  };

  const handleSelectFontSizePx = (newPx: number) => {
    const clamped = Math.min(28, Math.max(12, newPx));
    setFontSizePx(clamped);
    try {
      localStorage.setItem(FONT_SIZE_PX_STORAGE_KEY, String(clamped));
    } catch (e) {
      console.warn('Failed to save font size to localStorage:', e);
    }
  };

  const fetchCourses = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const res = await fetch(`/api/courses?t=${Date.now()}`, {
        cache: 'no-store'
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
            const updated = courseList.find((c) => c.id === prevSelected.id);
            return updated || prevSelected;
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

  useEffect(() => {
    fetchCourses();
  }, [fetchCourses]);

  const handleSelectCourse = (course: CourseItem) => {
    setSelectedCourse(course);
    setIsMobileSidebarOpen(false);
    try {
      localStorage.setItem(LAST_COURSE_STORAGE_KEY, String(course.id));
    } catch (e) {
      console.warn('Failed to save last course ID to localStorage:', e);
    }
  };

  const handleGoHome = useCallback(() => {
    setSelectedCourse(null);
    setIsMobileSidebarOpen(false);
    setIsZenMode(false);
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
            title="點擊回到法雲資訊網首頁"
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleGoHome();
              }
            }}
          >
            法雲資訊網
          </span>
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
          fetchCourses={fetchCourses}
          theme={theme}
          handleSelectTheme={handleSelectTheme}
          setIsSettingsOpen={setIsSettingsOpen}
          isLoading={isLoading}
          error={error}
          isZenMode={isZenMode}
          setIsZenMode={setIsZenMode}
          isMobileViewport={isMobileViewport}
          onGoHome={handleGoHome}
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
