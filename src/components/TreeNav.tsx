'use client';

import React, { useState, useMemo, useDeferredValue } from 'react';
import { CourseItem, TreeNode, ThemeType } from '@/types/course';
import { useAudio } from '@/context/AudioContext';

interface TreeNavProps {
  courses: CourseItem[];
  selectedCourse: CourseItem | null;
  onSelectCourse: (course: CourseItem) => void;
  onRefreshCourses: () => Promise<void>;
  theme: ThemeType;
  onSelectTheme: (theme: ThemeType) => void;
}

type MediaFilterType = 'all' | 'audio' | 'video' | 'pdf';

export default function TreeNav({
  courses,
  selectedCourse,
  onSelectCourse,
  onRefreshCourses,
  theme,
  onSelectTheme
}: TreeNavProps) {
  const { currentTrack, isPlaying } = useAudio();
  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearchQuery = useDeferredValue(searchQuery);

  const [mediaFilter, setMediaFilter] = useState<MediaFilterType>('all');
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [isHealing, setIsHealing] = useState<boolean>(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);

  // Build hierarchical tree: Main Menu -> Sub Menu -> Topic -> Courses
  const treeData = useMemo(() => {
    const rootNodes: TreeNode[] = [];
    const mainMap = new Map<string, TreeNode>();

    const q = deferredSearchQuery.trim().toLowerCase();

    courses.forEach((course) => {
      // 1. Filter by media type pill if selected
      if (mediaFilter === 'audio' && course.total_episodes === 0) return;
      if (mediaFilter === 'video' && !course.video_path) return;
      if (mediaFilter === 'pdf' && (!course.pdfs || course.pdfs.length === 0)) return;

      // 2. Filter by search query
      if (q) {
        const matchName = course.name.toLowerCase().includes(q);
        const matchLoc = course.location.toLowerCase().includes(q);
        const matchYear = course.time.toLowerCase().includes(q);
        const matchTopic = (course.topic_title || '').toLowerCase().includes(q);
        if (!matchName && !matchLoc && !matchYear && !matchTopic) {
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

      // 2. Sub Menu
      let subNode = mainNode.children?.find((c) => c.id === `sub-${course.main_menu}-${course.sub_menu}`);
      if (!subNode) {
        subNode = {
          id: `sub-${course.main_menu}-${course.sub_menu}`,
          label: course.sub_menu_title,
          type: 'submenu',
          children: [],
          count: 0
        };
        mainNode.children?.push(subNode);
      }
      subNode.count = (subNode.count || 0) + 1;

      // 3. Topic
      const topicLabel = course.topic_title && course.topic_title.trim() !== '' ? course.topic_title : '通用主題';
      let topicNode = subNode.children?.find((c) => c.id === `topic-${course.sub_menu}-${course.topic}`);
      if (!topicNode) {
        topicNode = {
          id: `topic-${course.sub_menu}-${course.topic}`,
          label: topicLabel,
          type: 'topic',
          children: [],
          count: 0
        };
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

  const handleWebScanTrigger = async () => {
    try {
      setIsScanning(true);
      setScanMessage('正在連線 fayun.org 掃描媒體庫...');
      const res = await fetch('/api/scan', { method: 'POST' });
      if (res.ok) {
        setScanMessage('✅ 媒體庫掃描與同步完成！');
        await onRefreshCourses();
      } else {
        setScanMessage('❌ 掃描失敗');
      }
    } catch (e: any) {
      setScanMessage(`❌ 錯誤: ${e.message}`);
    } finally {
      setIsScanning(false);
      setTimeout(() => setScanMessage(null), 4000);
    }
  };

  const handleAutoHealTrigger = async () => {
    try {
      setIsHealing(true);
      setScanMessage('🚑 正在自動巡檢並自我修復全站媒體/PDF鏈結...');
      const res = await fetch('/api/health-check', { method: 'POST' });
      if (res.ok) {
        setScanMessage('✅ 巡檢與自我修復完成！已更新所有正確鏈結！');
        await onRefreshCourses();
      } else {
        setScanMessage('❌ 巡檢修復失敗');
      }
    } catch (e: any) {
      setScanMessage(`❌ 錯誤: ${e.message}`);
    } finally {
      setIsHealing(false);
      setTimeout(() => setScanMessage(null), 5000);
    }
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
              onClick={() => node.course && onSelectCourse(node.course)}
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

  return (
    <aside className={`sidebar ${theme}`}>
      <div className="sidebar-header">
        <div className="brand">
          <div className="logo-icon">🌸</div>
          <div>
            <h1 className="brand-title">法雲資訊網</h1>
            <p className="brand-subtitle">玅境長老經典講記講述</p>
          </div>
        </div>

        {/* 5-Theme Selector Dropdown */}
        <select
          value={theme}
          onChange={(e) => onSelectTheme(e.target.value as ThemeType)}
          className="theme-dropdown"
          title="選擇主題配色風格"
        >
          <option value="dark">🌙 玄夜禪月 (深色)</option>
          <option value="light">☀️ 淨白雲卷 (淺色)</option>
          <option value="pine">🍃 松林竹韻 (竹綠)</option>
          <option value="sandalwood">🪵 古木沉香 (茶木)</option>
          <option value="lotus">🪷 紫蓮靜室 (紫藕)</option>
        </select>
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

        <div className="web-scan-bar">
          <button
            onClick={handleAutoHealTrigger}
            disabled={isHealing || isScanning}
            className="web-scan-btn heal-btn"
            title="自動巡檢全站 414 門課程鏈結，發現無效網址自動重新連線修正"
          >
            {isHealing ? '🚑 巡檢修復中...' : '🚑 自動巡檢與自我修復'}
          </button>
          <button
            onClick={handleWebScanTrigger}
            disabled={isScanning || isHealing}
            className="web-scan-btn"
            title="連線 fayun.org 檢查最新媒體上架"
          >
            {isScanning ? '⏳ 掃描中...' : '🔄 同步新媒體'}
          </button>
        </div>

        {scanMessage && <div className="scan-toast-msg">{scanMessage}</div>}

        <div className="tree-actions">
          <button onClick={expandAll} className="action-btn">
            全部展開
          </button>
          <button onClick={collapseAll} className="action-btn">
            全部折疊
          </button>
          <span className="total-badge">{courses.length} 門課程</span>
        </div>
      </div>

      <nav className="tree-container">
        {treeData.length > 0 ? (
          <ul className="tree-root-list">{renderTreeNodes(treeData)}</ul>
        ) : (
          <div className="no-search-results">未找到符合「{searchQuery}」的課程</div>
        )}
      </nav>

      <footer className="sidebar-footer">
        <span>© fayun.org 典藏庫</span>
      </footer>
    </aside>
  );
}
