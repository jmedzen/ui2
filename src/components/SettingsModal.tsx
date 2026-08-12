'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { ThemeType } from '@/types/course';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  theme: ThemeType;
  onSelectTheme: (theme: ThemeType) => void;
  fontSizePx: number;
  onSelectFontSize: (sizePx: number) => void;
  onRefreshCourses?: () => Promise<void>;
}

export default function SettingsModal({
  isOpen,
  onClose,
  theme,
  onSelectTheme,
  fontSizePx,
  onSelectFontSize,
  onRefreshCourses
}: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<'preferences' | 'logs'>('preferences');
  const [logs, setLogs] = useState<string>('讀取日誌中...');
  const [lastScan, setLastScan] = useState<string>('未知');
  const [totalCourses, setTotalCourses] = useState<number>(0);
  const [isFetchingLogs, setIsFetchingLogs] = useState<boolean>(false);
  const [isTriggeringScan, setIsTriggeringScan] = useState<boolean>(false);
  const [copyToast, setCopyToast] = useState<boolean>(false);

  const fetchLogs = useCallback(async () => {
    try {
      setIsFetchingLogs(true);
      const res = await fetch('/api/scan');
      if (res.ok) {
        const data = await res.json();
        setLogs(data.recentLogs || '無系統紀錄');
        setLastScan(data.lastScan || '未知');
        setTotalCourses(data.totalCourses || 0);
      } else {
        setLogs('⚠️ 無法讀取媒體同步日誌檔 (HTTP Error)');
      }
    } catch (e: any) {
      setLogs(`⚠️ 讀取日誌失敗: ${e.message}`);
    } finally {
      setIsFetchingLogs(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      fetchLogs();
    }
  }, [isOpen, fetchLogs]);

  const handleTriggerScan = async () => {
    try {
      setIsTriggeringScan(true);
      setLogs('⏳ 正在連線 fayun.org 掃描媒體庫與同步更新數據庫...');
      const res = await fetch('/api/scan', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setLogs(data.recentLogs || data.output || '掃描完成');
        setLastScan(data.lastScan || new Date().toLocaleString());
        if (data.totalCourses) setTotalCourses(data.totalCourses);
        if (onRefreshCourses) {
          await onRefreshCourses();
        }
      } else {
        setLogs(`❌ 掃描失敗: ${data.error || '未知錯誤'}\n${data.recentLogs || ''}`);
      }
    } catch (e: any) {
      setLogs(`❌ 執行同步出錯: ${e.message}`);
    } finally {
      setIsTriggeringScan(false);
    }
  };

  const handleCopyLogs = () => {
    if (navigator.clipboard && logs) {
      navigator.clipboard.writeText(logs);
      setCopyToast(true);
      setTimeout(() => setCopyToast(false), 2000);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="settings-modal-card shadow-card" onClick={(e) => e.stopPropagation()}>
        <div className="settings-modal-header">
          <div className="settings-modal-tabs">
            <button
              className={`settings-tab-btn ${activeTab === 'preferences' ? 'active' : ''}`}
              onClick={() => setActiveTab('preferences')}
            >
              🎨 系統偏好設定
            </button>
            <button
              className={`settings-tab-btn ${activeTab === 'logs' ? 'active' : ''}`}
              onClick={() => {
                setActiveTab('logs');
                fetchLogs();
              }}
            >
              📜 媒體同步與掃描紀錄
            </button>
          </div>

          <button className="settings-modal-close" onClick={onClose} title="關閉">
            ✕
          </button>
        </div>

        <div className="settings-modal-body">
          {activeTab === 'preferences' ? (
            <>
              {/* Theme Section */}
              <div className="settings-section">
                <h4 className="settings-section-title">🎨 視覺主題 (Zen Themes)</h4>
                <p className="settings-section-desc">選擇適合您專注研讀與視力舒適的禪意配色主題</p>

                <div className="theme-options-grid">
                  <button
                    className={`theme-option-btn dark ${theme === 'dark' ? 'active' : ''}`}
                    onClick={() => onSelectTheme('dark')}
                  >
                    <span className="theme-icon">🌙</span>
                    <span className="theme-name">玄夜禪月</span>
                    <span className="theme-tag">深色</span>
                  </button>

                  <button
                    className={`theme-option-btn light ${theme === 'light' ? 'active' : ''}`}
                    onClick={() => onSelectTheme('light')}
                  >
                    <span className="theme-icon">☀️</span>
                    <span className="theme-name">淨白雲卷</span>
                    <span className="theme-tag">淺色</span>
                  </button>

                  <button
                    className={`theme-option-btn pine ${theme === 'pine' ? 'active' : ''}`}
                    onClick={() => onSelectTheme('pine')}
                  >
                    <span className="theme-icon">🍃</span>
                    <span className="theme-name">松林竹韻</span>
                    <span className="theme-tag">竹綠</span>
                  </button>

                  <button
                    className={`theme-option-btn sandalwood ${theme === 'sandalwood' ? 'active' : ''}`}
                    onClick={() => onSelectTheme('sandalwood')}
                  >
                    <span className="theme-icon">🪵</span>
                    <span className="theme-name">古木沉香</span>
                    <span className="theme-tag">茶木</span>
                  </button>

                  <button
                    className={`theme-option-btn zen ${theme === 'zen' ? 'active' : ''}`}
                    onClick={() => onSelectTheme('zen')}
                  >
                    <span className="theme-icon">🍵</span>
                    <span className="theme-name">日式禪風</span>
                    <span className="theme-tag">和風抹茶</span>
                  </button>

                  <button
                    className={`theme-option-btn gruvbox ${theme === 'gruvbox' ? 'active' : ''}`}
                    onClick={() => onSelectTheme('gruvbox')}
                  >
                    <span className="theme-icon">🌾</span>
                    <span className="theme-name">Gruvbox</span>
                    <span className="theme-tag">復古暖調</span>
                  </button>
                </div>
              </div>

              {/* Font Size Section */}
              <div className="settings-section">
                <h4 className="settings-section-title">🔤 微調全站字體大小 (Font Size px)</h4>
                <p className="settings-section-desc">使用 ➖ 與 ➕ 按鈕精確調整全站字型像素大小 (12px ~ 28px)</p>

                <div className="font-size-stepper-control">
                  <button
                    className="stepper-btn"
                    onClick={() => onSelectFontSize(Math.max(12, fontSizePx - 1))}
                    disabled={fontSizePx <= 12}
                    title="縮小字型 (最小 12px)"
                  >
                    ➖
                  </button>

                  <div className="stepper-value-display">
                    <span className="stepper-num">{fontSizePx}</span>
                    <span className="stepper-unit">px</span>
                  </div>

                  <button
                    className="stepper-btn"
                    onClick={() => onSelectFontSize(Math.min(28, fontSizePx + 1))}
                    disabled={fontSizePx >= 28}
                    title="放大字型 (最大 28px)"
                  >
                    ➕
                  </button>

                  <button
                    className="stepper-reset-btn"
                    onClick={() => onSelectFontSize(16)}
                    title="重設為預設大小 (16px)"
                  >
                    🔄 重設 (16px)
                  </button>
                </div>

                {/* Live Text Preview Box */}
                <div className="font-size-preview-box">
                  <span className="preview-tag">即時預覽 ({fontSizePx}px)：</span>
                  <p className="preview-text" style={{ fontSize: `${fontSizePx}px` }}>
                    「極樂世界，無有眾苦，但受諸樂，故名極樂。彼佛光明無量，照十方國，無所障礙。」
                  </p>
                </div>
              </div>
            </>
          ) : (
            /* Log Tab Content */
            <div className="settings-section logs-section">
              {/* Stat Summary Header Cards */}
              <div className="log-stats-bar">
                <div className="stat-card">
                  <span className="stat-label">🕒 最近同步時間</span>
                  <span className="stat-value">{lastScan}</span>
                </div>
                <div className="stat-card">
                  <span className="stat-label">📚 收錄課程總數</span>
                  <span className="stat-value">{totalCourses ? `${totalCourses} 門` : '---'}</span>
                </div>
                <div className="stat-card">
                  <span className="stat-label">⚡ 自動巡檢狀態</span>
                  <span className="stat-value active">連線運作中</span>
                </div>
              </div>

              {/* Action Toolbar */}
              <div className="log-action-toolbar">
                <button
                  className="log-sync-btn"
                  onClick={handleTriggerScan}
                  disabled={isTriggeringScan || isFetchingLogs}
                >
                  {isTriggeringScan ? '⏳ 正在掃描同步中...' : '🔄 執行連線掃描與同步'}
                </button>

                <button
                  className="log-copy-btn"
                  onClick={handleCopyLogs}
                  disabled={!logs}
                >
                  {copyToast ? '✅ 已複製紀錄！' : '📋 複製日誌紀錄'}
                </button>

                <button
                  className="log-refresh-btn"
                  onClick={fetchLogs}
                  disabled={isFetchingLogs || isTriggeringScan}
                >
                  🔄 重新讀取 Log
                </button>
              </div>

              {/* Log Display Window */}
              <div className="log-window-wrapper">
                <div className="log-window-header">
                  <span className="log-file-tag">📄 scanner.log</span>
                  <span className="log-hint">紀錄 fayun.org 媒體掃描、上架與更新歷史資訊</span>
                </div>
                <pre className="log-window-body">
                  {logs}
                </pre>
              </div>
            </div>
          )}
        </div>

        <div className="settings-modal-footer">
          <button className="settings-save-btn" onClick={onClose}>
            完成設定
          </button>
        </div>
      </div>
    </div>
  );
}
