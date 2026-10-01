'use client';

import React, { useMemo } from 'react';
import { CourseItem } from '@/types/course';

interface HomePortalProps {
  courses: CourseItem[];
  onSelectCourse: (course: CourseItem) => void;
  onOpenMobileMenu?: () => void;
}

export default function HomePortal({
  courses,
  onSelectCourse,
  onOpenMobileMenu
}: HomePortalProps) {
  // Find flagship courses
  const yogaCourse = useMemo(
    () => courses.find((c) => c.name.includes('瑜伽師地論')) || courses[0] || null,
    [courses]
  );

  const diamondCourse = useMemo(
    () => courses.find((c) => c.name.includes('金剛') && c.name.includes('經')) || null,
    [courses]
  );

  const prajnaCourse = useMemo(
    () => courses.find((c) => c.name.includes('摩訶般若波羅蜜經')) || null,
    [courses]
  );

  const ahanCourse = useMemo(
    () => courses.find((c) => c.name.includes('雜阿含經') || c.name.includes('阿含')) || null,
    [courses]
  );

  const sastraCourse = useMemo(
    () => courses.find((c) => c.name.includes('大智度論')) || null,
    [courses]
  );

  const samathaCourse = useMemo(
    () => courses.find((c) => c.name.includes('修止觀法門') || c.name.includes('坐禪')) || null,
    [courses]
  );

  // Core featured courses list
  const featuredCourses = useMemo(() => {
    const list: { course: CourseItem; tag: string; desc: string; icon: string }[] = [];

    if (yogaCourse) {
      list.push({
        course: yogaCourse,
        tag: '核心論藏 · 鎮院大論',
        desc: '玅境長老一生學修弘化最核心巨著，深究百卷大論與真實義品之甚深境界。',
        icon: '🌟'
      });
    }

    if (diamondCourse) {
      list.push({
        course: diamondCourse,
        tag: '般若經藏 · 真空妙有',
        desc: '開演一切法無我、無人、無眾生、無壽者之究竟離相空觀，悟入無生法忍。',
        icon: '💎'
      });
    }

    if (prajnaCourse) {
      list.push({
        course: prajnaCourse,
        tag: '根本大經 · 菩薩廣行',
        desc: '大乘般若根本大部經典，深入詮釋二道五菩提、六波羅蜜多與諸法實相。',
        icon: '🪷'
      });
    }

    if (ahanCourse) {
      list.push({
        course: ahanCourse,
        tag: '原始正法 · 根本解脫',
        desc: '佛陀原始法教根本，如實觀察五蘊、十二處、十八界之無常、苦、空、無我。',
        icon: '📜'
      });
    }

    if (sastraCourse) {
      list.push({
        course: sastraCourse,
        tag: '龍樹大論 · 空宗寶典',
        desc: '龍樹菩薩釋大般若經之無盡寶藏，抉擇性空幻有，引導學人圓滿大乘佛道。',
        icon: '🏛️'
      });
    }

    if (samathaCourse) {
      list.push({
        course: samathaCourse,
        tag: '止觀雙運 · 實修指南',
        desc: '詳盡指導奢摩他（止）與毘婆舍那（觀）修習次第，入定離障、開顯聖智。',
        icon: '🧘'
      });
    }

    return list;
  }, [yogaCourse, diamondCourse, prajnaCourse, ahanCourse, sastraCourse, samathaCourse]);

  // Total statistics
  const totalCourses = courses.length;
  const totalVideoCourses = useMemo(() => courses.filter((c) => Boolean(c.video_path)).length, [courses]);
  const totalPdfCourses = useMemo(() => courses.filter((c) => c.pdfs && c.pdfs.length > 0).length, [courses]);

  return (
    <div className="home-portal-pane">
      {/* Hero Welcome Banner */}
      <section className="home-hero-card">
        <div className="home-hero-badge">
          <span className="home-hero-flower">🌸</span>
          <span className="home-hero-tag">法雲資訊網 · 典藏總覽</span>
        </div>

        <h1 className="home-hero-title">玅境長老經典講記典藏庫</h1>

        <p className="home-hero-subtitle">
          弘揚佛陀大乘第一義諦正法 · 宣演般若空性與瑜伽止觀 · 永續清淨法音無償流通
        </p>

        <p className="home-hero-intro">
          本站彙整法雲資訊網（<a href="https://www.fayun.org" target="_blank" rel="noopener noreferrer" className="copyright-link">fayun.org</a>）珍藏之玅境長老歷年講經開示，收錄完整原始音訊、影音講記與高清講義手稿筆記，提供十方僧俗大眾沉浸修習、止觀雙運。
        </p>

        <div className="home-hero-actions">
          {yogaCourse && (
            <button
              className="home-action-btn primary"
              onClick={() => onSelectCourse(yogaCourse)}
              title="立即進入長老一生弘化之重心典藏《瑜伽師地論》"
            >
              🌟 開始研讀核心講記：《瑜伽師地論》
            </button>
          )}

          {onOpenMobileMenu && (
            <button
              className="home-action-btn secondary mobile-only"
              onClick={onOpenMobileMenu}
              title="展開目錄檢視所有經論課程"
            >
              ☰ 展開 {totalCourses || 684} 門全站目錄
            </button>
          )}
        </div>
      </section>

      {/* Realtime Archive Stats Grid */}
      <section className="home-stats-grid">
        <div className="home-stat-card">
          <span className="stat-icon">📚</span>
          <div className="stat-data">
            <span className="stat-number">{totalCourses || 684}</span>
            <span className="stat-label">門完整講記課程</span>
          </div>
        </div>

        <div className="home-stat-card">
          <span className="stat-icon">🎙️</span>
          <div className="stat-data">
            <span className="stat-number">100%</span>
            <span className="stat-label">長老原音音訊全典藏</span>
          </div>
        </div>

        <div className="home-stat-card">
          <span className="stat-icon">🎥</span>
          <div className="stat-data">
            <span className="stat-number">{totalVideoCourses || 478}</span>
            <span className="stat-label">部隨身影音開示</span>
          </div>
        </div>

        <div className="home-stat-card">
          <span className="stat-icon">📄</span>
          <div className="stat-data">
            <span className="stat-number">{totalPdfCourses || 413}+</span>
            <span className="stat-label">部手稿筆記與講義</span>
          </div>
        </div>
      </section>

      {/* Four Dharma Divisions Banner */}
      <section className="home-divisions-section">
        <div className="section-header">
          <h2 className="section-title">🗂️ 四大經典法門導覽</h2>
          <span className="section-subtitle">點選代表經典立即進入深入修學</span>
        </div>

        <div className="home-divisions-grid">
          <div className="division-card">
            <div className="division-header">
              <span className="division-icon">📖</span>
              <div>
                <h3 className="division-name">佛法經論（經藏）</h3>
                <span className="division-meta">佛陀親說根本大乘經</span>
              </div>
            </div>
            <p className="division-desc">
              收錄金剛經、摩訶般若波羅蜜經、阿含經、法華經、維摩詰經、藥師經等多部經典，抉擇無上菩提道。
            </p>
            <div className="division-links">
              {diamondCourse && (
                <button className="division-chip" onClick={() => onSelectCourse(diamondCourse)}>
                  《金剛經》
                </button>
              )}
              {prajnaCourse && (
                <button className="division-chip" onClick={() => onSelectCourse(prajnaCourse)}>
                  《摩訶般若波羅蜜經》
                </button>
              )}
              {ahanCourse && (
                <button className="division-chip" onClick={() => onSelectCourse(ahanCourse)}>
                  《雜阿含經》
                </button>
              )}
            </div>
          </div>

          <div className="division-card">
            <div className="division-header">
              <span className="division-icon">🏛️</span>
              <div>
                <h3 className="division-name">釋論發微（論藏）</h3>
                <span className="division-meta">菩薩造論顯明正理</span>
              </div>
            </div>
            <p className="division-desc">
              收錄瑜伽師地論、大智度論、攝大乘論、中論、百法明門論，以深細智慧建立正見、遣除凡情執著。
            </p>
            <div className="division-links">
              {yogaCourse && (
                <button className="division-chip" onClick={() => onSelectCourse(yogaCourse)}>
                  《瑜伽師地論》
                </button>
              )}
              {sastraCourse && (
                <button className="division-chip" onClick={() => onSelectCourse(sastraCourse)}>
                  《大智度論》
                </button>
              )}
            </div>
          </div>

          <div className="division-card">
            <div className="division-header">
              <span className="division-icon">🧘</span>
              <div>
                <h3 className="division-name">禪修止觀（實修）</h3>
                <span className="division-meta">定慧等持身心寂滅</span>
              </div>
            </div>
            <p className="division-desc">
              長老親述坐禪實修指引、奢摩他入定法門、毘婆舍那如實觀察，引導行者遠離掉舉惛沈、生起無漏正智。
            </p>
            <div className="division-links">
              {samathaCourse && (
                <button className="division-chip" onClick={() => onSelectCourse(samathaCourse)}>
                  《修止觀法門》
                </button>
              )}
            </div>
          </div>

          <div className="division-card">
            <div className="division-header">
              <span className="division-icon">⚖️</span>
              <div>
                <h3 className="division-name">戒律儀軌（行持）</h3>
                <span className="division-meta">防非止惡清淨道基</span>
              </div>
            </div>
            <p className="division-desc">
              開示瑜伽菩薩戒本、在家菩薩戒與沙彌律儀，以戒為師，端正威儀，清淨三業，為定慧修持之堅實基石。
            </p>
          </div>
        </div>
      </section>

      {/* Featured Scripture Cards */}
      <section className="home-featured-section">
        <div className="section-header">
          <h2 className="section-title">🌟 核心經典講記推薦</h2>
          <span className="section-subtitle">點擊卡片即可開始收聽音訊、觀看講記或研讀講義</span>
        </div>

        <div className="featured-grid">
          {featuredCourses.map(({ course, tag, desc, icon }) => (
            <div
              key={course.id}
              className="featured-course-card"
              onClick={() => onSelectCourse(course)}
              role="button"
              tabIndex={0}
              title={`進入研讀《${course.name}》`}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectCourse(course);
                }
              }}
            >
              <div className="featured-card-top">
                <span className="featured-icon">{icon}</span>
                <span className="featured-tag">{tag}</span>
              </div>

              <h3 className="featured-title">{course.name}</h3>

              <p className="featured-desc">{desc}</p>

              <div className="featured-meta-row">
                <span className="featured-meta-item">📍 {course.location || '法雲寺禪學院'}</span>
                {course.time && <span className="featured-meta-item">🗓️ {course.time} 年</span>}
                {course.total_episodes > 0 && (
                  <span className="featured-meta-item">🎧 {course.total_episodes} 講</span>
                )}
              </div>

              <div className="featured-footer">
                <div className="featured-badges">
                  {course.total_episodes > 0 && <span className="media-badge audio">🎙️ 音訊</span>}
                  {course.video_path && <span className="media-badge video">🎥 影音</span>}
                  {course.pdfs && course.pdfs.length > 0 && <span className="media-badge pdf">📚 講義</span>}
                </div>
                <span className="featured-enter-btn">開始研讀 ➜</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Zen Footer Copyright Disclaimer */}
      <footer className="home-footer-disclaimer">
        <div className="footer-zen-divider">🌸 ☸ 🌸</div>
        <p className="footer-line">
          本站所收錄之所有經論講述錄音、MP3 音訊、影音講記檔及 PDF 筆記講義，
          其智慧財產權與著作權<strong>全權屬於 法雲資訊網 (<a href="https://www.fayun.org" target="_blank" rel="noopener noreferrer" className="copyright-link">fayun.org</a>) 及相關著作權人所有</strong>。
        </p>
        <p className="footer-subline">
          純為非營利弘法與十方學修無償流通 · 願正法久住 · 普利人天
        </p>
      </footer>
    </div>
  );
}
