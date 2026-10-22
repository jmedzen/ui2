'use client';

import React, { useState, useMemo, useDeferredValue, useSyncExternalStore } from 'react';
import { CourseItem, TreeNode, ThemeType } from '@/types/course';
import { useAudio } from '@/context/AudioContext';
import { isFavorite, type FavoriteRecord } from '@/lib/playbackStore';
import {
  getRecentCoursesSnapshot,
  getRecentCoursesServerSnapshot,
  pushRecentCourse,
  subscribeRecentCourses
} from '@/lib/recentCourses';

/**
 * How many recently-visited courses are remembered and displayed.
 *
 * Shared by the reader and the writer below so the stored list and the rendered
 * list can never drift apart.
 */
interface TreeNavProps {
  courses: CourseItem[];
  selectedCourse: CourseItem | null;
  onSelectCourse: (course: CourseItem) => void;
  /** Palette class applied to the sidebar shell. */
  theme: ThemeType;
  onOpenSettings: () => void;
  onGoHome?: () => void;
  favorites: FavoriteRecord[];
  onToggleFavorite: (course: CourseItem) => void;
}

type MediaFilterType = 'all' | 'audio' | 'video' | 'pdf';

export default function TreeNav({
  courses,
  selectedCourse,
  onSelectCourse,
  theme,
  onOpenSettings,
  onGoHome,
  favorites,
  onToggleFavorite
}: TreeNavProps) {
  const { currentTrack } = useAudio();
  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearchQuery = useDeferredValue(searchQuery);

  const [mediaFilter, setMediaFilter] = useState<MediaFilterType>('all');
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});

  // Recently Visited Courses History.
  //
  // Read from an external store rather than mirrored into state by an effect:
  // the list is written when a course is opened, so the write belongs in the
  // click handler, and the read is a snapshot subscription.
  const [isRecentOpen, setIsRecentOpen] = useState<boolean>(true);
  const [isFavoritesOpen, setIsFavoritesOpen] = useState<boolean>(true);
  const recentCourseIds = useSyncExternalStore(
    subscribeRecentCourses,
    getRecentCoursesSnapshot,
    getRecentCoursesServerSnapshot
  );

  /**
   * Selection handler for every entry point in the sidebar.
   *
   * Recording the visit here (a click handler) rather than in an effect keeps
   * the write on the interaction that caused it, so there is no second render
   * just to update the recent list.
   */
  const handleOpenCourse = (course: CourseItem) => {
    pushRecentCourse(course.id);
    onSelectCourse(course);
  };

  const recentList = useMemo(() => {
    // Index the catalog once so the "recently studied" lookup stays O(n) overall
    // instead of running a linear scan per recent id.
    const byId = new Map<number, CourseItem>();
    for (const c of courses) byId.set(c.id, c);
    return recentCourseIds
      .map((id) => byId.get(id))
      .filter((c): c is CourseItem => Boolean(c));
  }, [recentCourseIds, courses]);

  /**
   * Favorites resolved against the live catalog.
   *
   * A stored favorite whose course disappeared from the catalog (renamed or
   * removed upstream) is skipped rather than rendered as a dead chip; its
   * record is left in storage so it comes back if the course returns.
   */
  const favoriteList = useMemo(() => {
    const byId = new Map<number, CourseItem>();
    for (const c of courses) byId.set(c.id, c);
    return favorites
      .map((fav) => byId.get(fav.id))
      .filter((c): c is CourseItem => Boolean(c));
  }, [favorites, courses]);

  // Build hierarchical tree: Main Menu -> Sub Menu -> Topic -> Courses with O(N) Map Indexing
  const treeData = useMemo(() => {
    const rootNodes: TreeNode[] = [];
    const mainMap = new Map<string, TreeNode>();
    const subMap = new Map<string, TreeNode>();
    const topicMap = new Map<string, TreeNode>();

    const q = deferredSearchQuery.trim().toLowerCase();

    courses.forEach((course) => {
      // 1. Filter by media type pill if selected
      // The 音訊 pill must test whether an audio file actually exists, not the
      // episode count. `total_episodes === 0` matched nothing in the catalog
      // (every row has episodes), so 音訊 showed the same 684 rows as 全部 while
      // 161 courses have no audio_path at all — 157 of them video-only.
      if (mediaFilter === 'audio' && !course.audio_path) return;
      if (mediaFilter === 'video' && !course.video_path) return;
      if (mediaFilter === 'pdf' && (!course.pdfs || course.pdfs.length === 0)) return;

      // 2. Filter by search query
      // Search the branch titles the user can actually see in the tree as well
      // as the row's own fields; matching only name/location/time/topic meant
      // typing a visible category such as 開示與法語 returned "未找到".
      //
      // Every term must match (AND, not OR): typing "金剛 1998" used to return
      // every 金剛 course plus every 1998 course, which is rarely what a reader
      // narrowing a catalogue wants. PDF filenames are included because the
      // lecture-note titles are often the only place a topic is named in full.
      if (q) {
        const terms = q.split(/\s+/).filter(Boolean);
        const haystack = [
          course.name,
          course.main_menu_title,
          course.sub_menu_title,
          course.location,
          course.time,
          course.topic_title,
          course.comment || '',
          ...(course.pdfs || []).map((p) => p.filename)
        ]
          .map((value) => (value || '').toLowerCase())
          .join('\u0000');
        if (!terms.every((term) => haystack.includes(term))) {
          return;
        }
      }

      // 1. Main Menu
      let mainNode = mainMap.get(course.main_menu);
      if (!mainNode) {
        mainNode = {
          id: `main-${course.main_menu}`,
          label: course.main_menu_title,
          type: 'menu',
          children: [],
          count: 0
        };
        mainMap.set(course.main_menu, mainNode);
        rootNodes.push(mainNode);
      }
      mainNode.count = (mainNode.count || 0) + 1;

      // 2. Sub Menu - O(1) Hash Map lookup
      const subKey = `${course.main_menu}__${course.sub_menu}`;
      let subNode = subMap.get(subKey);
      if (!subNode) {
        subNode = {
          id: `sub-${course.main_menu}-${course.sub_menu}`,
          label: course.sub_menu_title,
          type: 'submenu',
          children: [],
          count: 0
        };
        subMap.set(subKey, subNode);
        mainNode.children?.push(subNode);
      }
      subNode.count = (subNode.count || 0) + 1;

      // 3. Topic - O(1) Hash Map lookup
      const topicLabel = course.topic_title && course.topic_title.trim() !== '' ? course.topic_title : '通用主題';
      const topicKey = `${subKey}__${course.topic}`;
      let topicNode = topicMap.get(topicKey);
      if (!topicNode) {
        topicNode = {
          id: `topic-${course.sub_menu}-${course.topic}`,
          label: topicLabel,
          type: 'topic',
          children: [],
          count: 0
        };
        topicMap.set(topicKey, topicNode);
        subNode.children?.push(topicNode);
      }
      topicNode.count = (topicNode.count || 0) + 1;

      // 4. Course Leaf Node
      topicNode.children?.push({
        id: `course-${course.id}`,
        label: course.name,
        type: 'course',
        course: course
      });
    });

    return rootNodes;
  }, [courses, deferredSearchQuery, mediaFilter]);

  const filteredCount = useMemo(() => {
    return treeData.reduce((acc, node) => acc + (node.count || 0), 0);
  }, [treeData]);

  const toggleNode = (id: string) => {
    setExpandedNodes((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const expandAll = () => {
    const newExpanded: Record<string, boolean> = {};
    const traverse = (nodes: TreeNode[]) => {
      nodes.forEach((n) => {
        if (n.children && n.children.length > 0) {
          newExpanded[n.id] = true;
          traverse(n.children);
        }
      });
    };
    traverse(treeData);
    setExpandedNodes(newExpanded);
  };

  const collapseAll = () => {
    setExpandedNodes({});
  };

  const renderTreeNodes = (nodes: TreeNode[], depth = 0) => {
    return nodes.map((node) => {
      const isExpanded = expandedNodes[node.id] || deferredSearchQuery.trim().length > 0;
      const isSelected = selectedCourse?.id === node.course?.id;

      if (node.type === 'course') {
        const hasVideo = !!node.course?.video_path;
        const isCurrentlyPlayingCourse = currentTrack && currentTrack.courseId === node.course?.id;

        return (
          <li key={node.id} className="tree-leaf-item">
            <button
              onClick={() => node.course && handleOpenCourse(node.course)}
              className={`tree-leaf-btn ${isSelected ? 'selected' : ''}`}
              style={{ paddingLeft: `${depth * 14 + 16}px` }}
            >
              <span className="leaf-icon">
                {isCurrentlyPlayingCourse ? (
                  <span className="tree-playing-icon" title="背景播放中">🔊</span>
                ) : hasVideo ? (
                  '🎬'
                ) : (
                  '📜'
                )}
              </span>
              <span className={`leaf-title ${isCurrentlyPlayingCourse ? 'playing-highlight' : ''}`}>
                {node.label}
              </span>
              {hasVideo && <span className="badge-video" title="包含影音影片">🎥 影音</span>}
              {node.course?.total_episodes ? (
                <span className="badge-episodes">{node.course.total_episodes}集</span>
              ) : null}
              {node.course?.pdfs && node.course.pdfs.length > 0 && (
                <span className="badge-pdf" title={`包含 ${node.course.pdfs.length} 份 PDF 講義筆記`}>📄 講義</span>
              )}
              {node.course && (
                <span
                  role="button"
                  tabIndex={0}
                  className={`leaf-favorite-btn ${isFavorite(favorites, node.course.id) ? 'active' : ''}`}
                  title={
                    isFavorite(favorites, node.course.id)
                      ? '移除收藏'
                      : '加入收藏（可在側欄「我的收藏」快速回到本課程）'
                  }
                  aria-label={
                    isFavorite(favorites, node.course.id) ? '移除收藏' : '加入收藏'
                  }
                  aria-pressed={isFavorite(favorites, node.course.id)}
                  onClick={(e) => {
                    // The row itself selects the course; the star must not.
                    e.stopPropagation();
                    if (node.course) onToggleFavorite(node.course);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      if (node.course) onToggleFavorite(node.course);
                    }
                  }}
                >
                  {isFavorite(favorites, node.course.id) ? '★' : '☆'}
                </span>
              )}
            </button>
          </li>
        );
      }

      const hasChildren = node.children && node.children.length > 0;

      return (
        <li key={node.id} className="tree-branch-item">
          <div
            className={`tree-branch-header ${node.type}`}
            style={{ paddingLeft: `${depth * 14 + 12}px` }}
            onClick={() => hasChildren && toggleNode(node.id)}
          >
            <span className={`arrow-icon ${isExpanded ? 'open' : ''}`}>
              {hasChildren ? '▶' : '•'}
            </span>
            <span className="branch-label">{node.label}</span>
            {node.count !== undefined && (
              <span className="branch-count">({node.count})</span>
            )}
          </div>
          {hasChildren && isExpanded && (
            <ul className="tree-sub-list">{renderTreeNodes(node.children!, depth + 1)}</ul>
          )}
        </li>
      );
    });
  };

  const handleBrandClick = () => {
    setSearchQuery('');
    setMediaFilter('all');
    if (onGoHome) {
      onGoHome();
    }
  };

  return (
    <aside className={`sidebar ${theme}`}>
      <div className="sidebar-header">
        <div
          className="brand"
          onClick={handleBrandClick}
          role="button"
          tabIndex={0}
          title="點擊回到妙境法軒首頁"
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleBrandClick();
            }
          }}
        >
          <div className="logo-icon">🌸</div>
          <div>
            <h1 className="brand-title">妙境法軒</h1>
            <p className="brand-subtitle">玅境長老經典講記講述</p>
          </div>
        </div>

        {/* Top-Left Settings Modal Trigger Button */}
        <button
          onClick={onOpenSettings}
          className="settings-open-btn"
          title="開啟系統與字體設定面板"
        >
          ⚙️ 設定
        </button>
      </div>

      <div className="search-section">
        <div className="search-input-wrapper">
          <span className="search-icon">🔍</span>
          <input
            type="text"
            placeholder="搜尋經論名稱、地點、年份..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="search-input"
          />
          {searchQuery && (
            <button className="search-clear" onClick={() => setSearchQuery('')}>
              ✕
            </button>
          )}
        </div>

        {/* Media Filter Pills */}
        <div className="media-filter-pills">
          <button
            className={`filter-pill ${mediaFilter === 'all' ? 'active' : ''}`}
            onClick={() => setMediaFilter('all')}
          >
            全部
          </button>
          <button
            className={`filter-pill ${mediaFilter === 'audio' ? 'active' : ''}`}
            onClick={() => setMediaFilter('audio')}
          >
            🎙️ 音訊
          </button>
          <button
            className={`filter-pill ${mediaFilter === 'video' ? 'active' : ''}`}
            onClick={() => setMediaFilter('video')}
          >
            🎥 影音
          </button>
          <button
            className={`filter-pill ${mediaFilter === 'pdf' ? 'active' : ''}`}
            onClick={() => setMediaFilter('pdf')}
          >
            📚 講義
          </button>
        </div>



        <div className="tree-actions">
          <button onClick={expandAll} className="action-btn">
            全部展開
          </button>
          <button onClick={collapseAll} className="action-btn">
            全部折疊
          </button>
          <span className="total-badge">
            {mediaFilter !== 'all' || deferredSearchQuery.trim()
              ? `${filteredCount} / ${courses.length} 門課程`
              : `${courses.length} 門課程`}
          </span>
        </div>
      </div>

      {/* Recently Visited Courses Shortcut */}
      {recentList.length > 0 && !deferredSearchQuery.trim() && (
        <div className="recent-study-section">
          <div
            className="recent-study-header"
            onClick={() => setIsRecentOpen(!isRecentOpen)}
            title="點擊展開/收合最近研讀課程"
          >
            <span className="recent-study-title">⭐ 最近研讀 ({recentList.length})</span>
            <span className={`recent-arrow ${isRecentOpen ? 'open' : ''}`}>
              {isRecentOpen ? '▼' : '▶'}
            </span>
          </div>
          {isRecentOpen && (
            <div className="recent-study-chips">
              {recentList.map((c) => (
                <button
                  key={c.id}
                  onClick={() => handleOpenCourse(c)}
                  className={`recent-chip ${selectedCourse?.id === c.id ? 'active' : ''}`}
                  title={`重返研讀：${c.name}`}
                >
                  <span className="recent-chip-icon">📖</span>
                  <span className="recent-chip-name">{c.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* My Favorites */}
      {favoriteList.length > 0 && !deferredSearchQuery.trim() && (
        <div className="recent-study-section favorites-section">
          <div
            className="recent-study-header"
            onClick={() => setIsFavoritesOpen(!isFavoritesOpen)}
            title="點擊展開/收合我的收藏"
          >
            <span className="recent-study-title">★ 我的收藏 ({favoriteList.length})</span>
            <span className={`recent-arrow ${isFavoritesOpen ? 'open' : ''}`}>
              {isFavoritesOpen ? '▼' : '▶'}
            </span>
          </div>
          {isFavoritesOpen && (
            <div className="recent-study-chips">
              {favoriteList.map((c) => (
                <span key={c.id} className="recent-chip-wrapper">
                  <button
                    onClick={() => handleOpenCourse(c)}
                    className={`recent-chip ${selectedCourse?.id === c.id ? 'active' : ''}`}
                    title={`前往《${c.name}》`}
                  >
                    <span className="recent-chip-icon">★</span>
                    <span className="recent-chip-name">{c.name}</span>
                  </button>
                  <button
                    className="favorite-remove-btn"
                    onClick={() => onToggleFavorite(c)}
                    title="移除收藏"
                    aria-label={`從收藏移除《${c.name}》`}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <nav className="tree-container">
        {treeData.length > 0 ? (
          <ul className="tree-root-list">{renderTreeNodes(treeData)}</ul>
        ) : (
          <div className="no-search-results">未找到符合「{searchQuery}」的課程</div>
        )}
      </nav>

      <footer className="sidebar-footer">
        <button
          type="button"
          onClick={onOpenSettings}
          className="sidebar-copyright-link"
          title="點擊檢視法雲資訊網 (fayun.org) 著作權與非營利弘法聲明"
        >
          © 版權所有：法雲資訊網 fayun.org
        </button>
      </footer>
    </aside>
  );
}
