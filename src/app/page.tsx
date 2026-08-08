'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { CourseItem, ThemeType } from '@/types/course';
import { AudioProvider } from '@/context/AudioContext';
import TreeNav from '@/components/TreeNav';
import CourseDetail from '@/components/CourseDetail';
import GlobalAudioPlayer from '@/components/GlobalAudioPlayer';
import initialDb from '@/data/courses_db.json';

const THEME_STORAGE_KEY = 'fayun_theme';

export default function Home() {
  // Initialize state immediately from bundled JSON data for 0ms load time
  const initialCourses: CourseItem[] = (initialDb.courses as CourseItem[]) || [];
  const initialDefaultCourse =
    initialCourses.find((c) => c.name.includes('瑜伽師地論')) || initialCourses[0] || null;

  const [courses, setCourses] = useState<CourseItem[]>(initialCourses);
  const [selectedCourse, setSelectedCourse] = useState<CourseItem | null>(initialDefaultCourse);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeType>('dark');
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState<boolean>(false);

  // Restore saved theme from localStorage on mount
  useEffect(() => {
    try {
      const savedTheme = localStorage.getItem(THEME_STORAGE_KEY) as ThemeType | null;
      if (savedTheme && ['dark', 'light', 'pine', 'sandalwood', 'lotus'].includes(savedTheme)) {
        setTheme(savedTheme);
      }
    } catch (e) {
      console.warn('Failed to restore theme from localStorage:', e);
    }
  }, []);

  const handleSelectTheme = (newTheme: ThemeType) => {
    setTheme(newTheme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, newTheme);
    } catch (e) {
      console.warn('Failed to save theme to localStorage:', e);
    }
  };

  const fetchCourses = useCallback(async () => {
    try {
      const res = await fetch('/api/courses');
      if (!res.ok) {
        throw new Error(`HTTP error ${res.status}`);
      }
      const data = await res.json();
      const courseList: CourseItem[] = data.courses || [];
      if (courseList.length > 0) {
        setCourses(courseList);
        setSelectedCourse((prevSelected) => {
          if (prevSelected) {
            const updated = courseList.find((c) => c.id === prevSelected.id);
            return updated || prevSelected;
          }
          return courseList.find((c) => c.name.includes('瑜伽師地論')) || courseList[0] || null;
        });
      }
    } catch (err: any) {
      console.warn('Failed to refresh courses from API, using bundled DB:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCourses();
  }, [fetchCourses]);

  const handleSelectCourse = (course: CourseItem) => {
    setSelectedCourse(course);
    setIsMobileSidebarOpen(false);
  };

  return (
    <AudioProvider>
      <div className={`app-root ${theme}`}>
        {/* Mobile Top Navbar */}
        <div className="mobile-navbar">
          <button
            className="mobile-menu-btn"
            onClick={() => setIsMobileSidebarOpen(!isMobileSidebarOpen)}
          >
            ☰ 目錄選單
          </button>
          <span className="mobile-title">法雲資訊網</span>
          <select
            value={theme}
            onChange={(e) => handleSelectTheme(e.target.value as ThemeType)}
            className="mobile-theme-btn"
          >
            <option value="dark">🌙 深色</option>
            <option value="light">☀️ 淺色</option>
            <option value="pine">🍃 竹綠</option>
            <option value="sandalwood">🪵 茶木</option>
            <option value="lotus">🪷 紫藕</option>
          </select>
        </div>

        <div className="layout-wrapper">
          {/* Left Sidebar Tree Navigation */}
          <div className={`sidebar-wrapper ${isMobileSidebarOpen ? 'mobile-open' : ''}`}>
            <TreeNav
              courses={courses}
              selectedCourse={selectedCourse}
              onSelectCourse={handleSelectCourse}
              onRefreshCourses={fetchCourses}
              theme={theme}
              onSelectTheme={handleSelectTheme}
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
              <CourseDetail course={selectedCourse} />
            ) : (
              <div className="global-empty">請點選左側目錄選擇課程</div>
            )}
          </div>
        </div>

        {/* Global Floating Audio Player */}
        <GlobalAudioPlayer />
      </div>
    </AudioProvider>
  );
}
