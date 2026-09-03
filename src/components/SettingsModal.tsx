'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
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
  const [isTriggeringHeal, setIsTriggeringHeal] = useState<boolean>(false);
  const [copyToast, setCopyToast] = useState<boolean>(false);

  // Resizable Width & Log Scroll References
  const [modalWidth, setModalWidth] = useState<number>(820);
  const [isResizing, setIsResizing] = useState<boolean>(false);
  const logBodyRef = useRef<HTMLPreElement>(null);
  const modalCardRef = useRef<HTMLDivElement>(null);

  // Restore saved custom modal width
  useEffect(() => {
    try {
      const savedWidth = localStorage.getItem('fayun_settings_modal_width');
      if (savedWidth) {
        const parsed = parseInt(savedWidth, 10);
        if (!isNaN(parsed) && parsed >= 500) {
          setModalWidth(parsed);
        }
      }
    } catch {}
  }, []);

  const scrollToBottom = useCallback(() => {
    if (logBodyRef.current) {
      logBodyRef.current.scrollTop = logBodyRef.current.scrollHeight;
    }
  }, []);

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

  // Auto scroll to bottom when logs update or tab switches to logs
  useEffect(() => {
    if (activeTab === 'logs') {
      const timer = setTimeout(scrollToBottom, 60);
      return () => clearTimeout(timer);
    }
  }, [logs, activeTab, scrollToBottom]);

  const handleTriggerScan = async () => {
    try {
      setIsTriggeringScan(true);
      const timestamp = new Date().toLocaleTimeString('zh-TW', { hour12: false });
      const promptMsg = `[${timestamp}] ⏳ [系統操作] 使用者觸發：連線 fayun.org 執行媒體同步與掃描中...`;
      setLogs((prev) => (prev ? `${prev}\n${promptMsg}` : promptMsg));

      const res = await fetch('/api/scan', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        if (data.recentLogs) {
          setLogs(data.recentLogs);
        } else {
          await fetchLogs();
        }
        setLastScan(data.lastScan || new Date().toLocaleString());
        if (data.totalCourses) setTotalCourses(data.totalCourses);
        if (onRefreshCourses) {
          await onRefreshCourses();
        }
      } else {
        const errorMsg = `[${timestamp}] ❌ [系統錯誤] 媒體同步失敗: ${data.error || '未知錯誤'}`;
        setLogs((prev) => `${prev}\n${errorMsg}`);
      }
    } catch (e: any) {
      const errorMsg = `[${new Date().toLocaleTimeString('zh-TW', { hour12: false })}] ❌ [系統錯誤] 執行同步出錯: ${e.message}`;
      setLogs((prev) => `${prev}\n${errorMsg}`);
    } finally {
      setIsTriggeringScan(false);
    }
  };

  const handleTriggerAutoHeal = async () => {
    try {
      setIsTriggeringHeal(true);
      const timestamp = new Date().toLocaleTimeString('zh-TW', { hour12: false });
      const promptMsg = `[${timestamp}] ⏳ [系統操作] 使用者觸發：全站 414 門課程巡檢與自我修復中...`;
      setLogs((prev) => (prev ? `${prev}\n${promptMsg}` : promptMsg));

      const res = await fetch('/api/health-check', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        if (data.recentLogs) {
          setLogs(data.recentLogs);
        } else {
          await fetchLogs();
        }
        if (onRefreshCourses) {
          await onRefreshCourses();
        }
      } else {
        const errorMsg = `[${timestamp}] ❌ [系統錯誤] 巡檢修復失敗: ${data.error || '未知錯誤'}`;
        setLogs((prev) => `${prev}\n${errorMsg}`);
      }
    } catch (e: any) {
      const errorMsg = `[${new Date().toLocaleTimeString('zh-TW', { hour12: false })}] ❌ [系統錯誤] 執行巡檢修復出錯: ${e.message}`;
      setLogs((prev) => `${prev}\n${errorMsg}`);
    } finally {
      setIsTriggeringHeal(false);
    }
  };

  const handleCopyLogs = () => {
    if (navigator.clipboard && logs) {
      navigator.clipboard.writeText(logs);
      setCopyToast(true);
      setTimeout(() => setCopyToast(false), 2000);
    }
  };

  const justResizedRef = useRef<boolean>(false);

  // Mouse Drag Resizing for Window Width
  const handleMouseDownResize = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    justResizedRef.current = true;
    const startX = e.clientX;
    const startWidth = modalWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const newWidth = Math.max(500, Math.min(window.innerWidth * 0.95, startWidth + deltaX));
      setModalWidth(newWidth);
      try {
        localStorage.setItem('fayun_settings_modal_width', String(Math.round(newWidth)));
      } catch {}
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      setTimeout(() => {
        justResizedRef.current = false;
      }, 300);

      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (isResizing || justResizedRef.current) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={handleBackdropClick}>
      <div
        ref={modalCardRef}
        className={`settings-modal-card shadow-card ${isResizing ? 'resizing' : ''}`}
        style={{ width: `${modalWidth}px` }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Mouse Drag Resize Handles */}
        <div
          className="modal-resize-handle-right"
          onMouseDown={handleMouseDownResize}
          title="↔️ 按住拖曳以改變彈窗寬度"
        />
        <div
          className="modal-resize-handle-corner"
          onMouseDown={handleMouseDownResize}
          title="↘️ 按住拖曳以改變彈窗寬度"
        />

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

          <div className="modal-header-actions">
            <span className="window-width-badge" title="目前彈窗寬度 (可按住右邊緣拖曳)">
              {Math.round(modalWidth)}px ↔️
            </span>
            <button className="settings-modal-close" onClick={onClose} title="關閉">
              ✕
            </button>
          </div>
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

              {/* Copyright & Dharma Source Section */}
              <div className="settings-section copyright-section">
                <h4 className="settings-section-title">📜 著作權與典藏法源申告 (Copyright)</h4>
                <p className="settings-section-desc">
                  本系統為佛教學人便利研讀玅境長老宣說經論講記所開發之非營利輔助學修工具
                </p>
                <div className="settings-copyright-box">
                  <div className="copyright-line">
                    <span className="c-tag">著作權歸屬</span>
                    <span className="c-content">
                      全站所有經論講記錄音、影音、文字講義及 PDF 筆記，其智慧財產權與著作權<strong>全權屬於 法雲資訊網 (<a href="https://www.fayun.org" target="_blank" rel="noopener noreferrer" className="copyright-link">fayun.org</a>) 及相關著作權人</strong>。
                    </span>
                  </div>
                  <div className="copyright-line">
                    <span className="c-tag">非營利宗旨</span>
                    <span className="c-content">
                      本平台完全免費、無償流通，供一切大眾研習正法。<strong>嚴禁任何未經原機構書面許可之商業轉售、營利授課或付費營銷用途</strong>。
                    </span>
                  </div>
                  <div className="copyright-line">
                    <span className="c-tag">官方原創網址</span>
                    <span className="c-content">
                      法雲資訊網原典藏出處：<a href="https://www.fayun.org" target="_blank" rel="noopener noreferrer" className="copyright-link">https://www.fayun.org</a>
                    </span>
                  </div>
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

              {/* Action Toolbar with Tooltips */}
              <div className="log-action-toolbar">
                <div className="tooltip-action-wrapper" data-tooltip="連線 fayun.org 掃描新上架之佛法經論、禪修開示與音訊影音媒體資源">
                  <button
                    className="log-sync-btn"
                    onClick={handleTriggerScan}
                    disabled={isTriggeringScan || isTriggeringHeal || isFetchingLogs}
                    title="連線 fayun.org 掃描新上架之佛法經論、禪修開示與音訊影音媒體資源"
                  >
                    {isTriggeringScan ? '⏳ 正在掃描同步中...' : '🔄 同步新媒體'}
                  </button>
                </div>

                <div className="tooltip-action-wrapper" data-tooltip="自動檢測全站 414 門課程之音訊、影音與 PDF 講義鏈結，發現無效網址自動校正修復">
                  <button
                    className="log-heal-btn"
                    onClick={handleTriggerAutoHeal}
                    disabled={isTriggeringHeal || isTriggeringScan || isFetchingLogs}
                    title="自動檢測全站 414 門課程之音訊、影音與 PDF 講義鏈結，發現無效網址自動校正修復"
                  >
                    {isTriggeringHeal ? '🚑 正在巡檢修復中...' : '🚑 自我巡檢自動修復'}
                  </button>
                </div>

                <div className="tooltip-action-wrapper" data-tooltip="將當前呈現的媒體掃描與修復日誌複製到系統剪貼簿">
                  <button
                    className="log-copy-btn"
                    onClick={handleCopyLogs}
                    disabled={!logs}
                    title="將當前呈現的媒體掃描與修復日誌複製到系統剪貼簿"
                  >
                    {copyToast ? '✅ 已複製紀錄！' : '📋 複製日誌紀錄'}
                  </button>
                </div>

                <div className="tooltip-action-wrapper" data-tooltip="從網頁伺服器重新載入最新 scanner.log 內容">
                  <button
                    className="log-refresh-btn"
                    onClick={fetchLogs}
                    disabled={isFetchingLogs || isTriggeringScan || isTriggeringHeal}
                    title="從網頁伺服器重新載入最新 scanner.log 內容"
                  >
                    🔄 重新整理日誌
                  </button>
                </div>
              </div>

              {/* Log Display Window */}
              <div className="log-window-wrapper">
                <div className="log-window-header">
                  <span className="log-file-tag">📄 scanner.log</span>
                  <span className="log-hint">紀錄 fayun.org 媒體掃描、新上架與路徑自我修復歷史資訊 (自動跳至最新)</span>
                </div>
                <pre className="log-window-body" ref={logBodyRef}>
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
