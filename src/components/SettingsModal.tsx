'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ThemeType } from '@/types/course';
import { getStoredTaskToken, setStoredTaskToken, taskTokenHeaders } from '@/lib/taskToken';
import packageInfo from '../../package.json';

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
  // Structured outcome of the most recent run. Completion is detected from this
  // (by matching the run id returned by POST) instead of by searching the log
  // tail for magic strings: those strings did not match what the Python scripts
  // actually emit, and both scripts share one log file, so a previous scan's
  // "Scan finished" line made a later heal run look finished immediately.
  const [lastRun, setLastRunState] = useState<{ id?: string; task?: string; ok?: boolean } | null>(null);
  // Mirror of `lastRun` that is readable synchronously inside the polling loop:
  // setState is asynchronous, so comparing against the state value would lag.
  const lastRunRef = useRef<{ id?: string; task?: string; ok?: boolean } | null>(null);
  const setLastRun = useCallback((value: { id?: string; task?: string; ok?: boolean } | null) => {
    lastRunRef.current = value;
    setLastRunState(value);
  }, []);
  const [lastScan, setLastScan] = useState<string>('未知');
  const [totalCourses, setTotalCourses] = useState<number>(0);
  const [cacheStats, setCacheStats] = useState<{ currentBytes: number; maxBytes: number; fileCount: number; maxGb: number } | null>(null);
  const [isFetchingLogs, setIsFetchingLogs] = useState<boolean>(false);
  const [isTriggeringScan, setIsTriggeringScan] = useState<boolean>(false);
  /** True when the server reports a maintenance task holding the lock. */
  const [isTaskRunning, setIsTaskRunning] = useState<boolean>(false);
  const [isTriggeringHeal, setIsTriggeringHeal] = useState<boolean>(false);
  const [copyToast, setCopyToast] = useState<boolean>(false);
  // Transient "you triggered X" notice, rendered as a banner instead of being
  // spliced into `logs`. It used to be prepended to the log text, which the next
  // poll overwrote (the server tail does not contain it) -- and appending the
  // server tail to it instead made the same lines accumulate on every poll.
  const [localNotice, setLocalNotice] = useState<string>('');
  // The task endpoints now REQUIRE a credential (see authorizeTaskRequest).
  // Without TASK_API_TOKEN the server generates one per boot and prints it to the
  // log, so the operator pastes it here once.
  //
  // This state is for DISPLAY only. Requests read the token straight from
  // localStorage (see `safeFetchJson`), so there is no effect and no extra render
  // just to publish a value the network layer can read for itself.
  const [taskToken, setTaskToken] = useState<string>(() =>
    typeof window === 'undefined' ? '' : getStoredTaskToken()
  );
  const [needsTaskToken, setNeedsTaskToken] = useState<boolean>(false);

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

  // The log now refreshes every 3s. Auto-scrolling on every update would yank
  // the view back to the bottom while the user is reading earlier lines, so the
  // window only follows the tail when it is already near the bottom.
  const stickToBottomRef = useRef<boolean>(true);
  const handleLogScroll = useCallback(() => {
    const el = logBodyRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 40;
  }, []);

  const safeFetchJson = useCallback(async (url: string, options?: RequestInit) => {
    try {
      // Read the token at call time rather than closing over React state, so
      // this callback has no dependency on it and never goes stale after the
      // operator pastes a token.
      const opts: RequestInit = { ...options, headers: { ...taskTokenHeaders(), ...(options?.headers as Record<string, string> | undefined) } };
      const res = await fetch(url, opts);
      const text = await res.text();
      try {
        const json = JSON.parse(text);
        if (res.status === 401 || res.status === 403) {
          // Surface the "token required/invalid" case as a prompt rather than as
          // a generic failure, so the fix (paste the token) is obvious.
          setNeedsTaskToken(true);
        }
        return { ok: res.ok, status: res.status, data: json };
      } catch {
        return { ok: false, status: res.status, data: { error: text ? text.slice(0, 200) : '伺服器未傳回 JSON 格式' } };
      }
    } catch (err: any) {
      return { ok: false, status: 0, data: { error: err.message || '網路連線失敗' } };
    }
  }, []);

  const fetchLogs = useCallback(async (): Promise<string | null> => {
    try {
      setIsFetchingLogs(true);
      const { ok, data } = await safeFetchJson('/api/scan');
      if (ok) {
        setLogs(data.recentLogs || '無系統紀錄');
        setLastScan(data.lastScan || '未知');
        setTotalCourses(data.totalCourses || 0);
        if (data.cacheStats) {
          setCacheStats(data.cacheStats);
        }
        if (data.lastRun) setLastRun(data.lastRun);
        // Carried by the same payload, so the poll below needs only one request.
        setIsTaskRunning(Boolean(data.isRunning));
        return data.recentLogs || '';
      } else {
        setLogs(`⚠️ 無法讀取媒體同步日誌檔 (${data.error || 'HTTP Error'})`);
        return null;
      }
    } catch (e: any) {
      setLogs(`⚠️ 讀取日誌失敗: ${e.message}`);
      return null;
    } finally {
      setIsFetchingLogs(false);
    }
    // setLastRun is a stable useCallback (ref mirror + setState), and
    // safeFetchJson is a stable useCallback with no deps, so neither can cause
    // this callback to be recreated on every render.
  }, [setLastRun, safeFetchJson]);

  useEffect(() => {
    if (isOpen) {
      fetchLogs();
    }
  }, [isOpen, fetchLogs]);

  // Keep the log window and the running indicator fresh while the log tab is
  // open, no matter who started the task.
  //
  // Previously this effect refreshed ONLY `isRunning` and threw the `recentLogs`
  // payload away, and the separate 2s log poll below ran only while this browser
  // was inside a trigger call. So once a run finished -- or when it was started
  // from another browser, by the 24h daemon, or by curl -- the window kept
  // showing whatever it had loaded when the modal opened, forever.
  useEffect(() => {
    if (!isOpen || activeTab !== 'logs') return;
    let cancelled = false;

    // One request per tick: fetchLogs writes the log text, the stat cards and
    // the running flag from the same /api/scan payload.
    const refresh = async () => {
      if (cancelled) return;
      await fetchLogs();
    };

    refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // fetchLogs is a stable useCallback, so this effect is not restarted by
    // unrelated re-renders and the interval survives while the tab stays open.
  }, [isOpen, activeTab, fetchLogs]);

  // Auto scroll to bottom when logs update or the tab switches, unless the user
  // has scrolled up to read earlier output.
  useEffect(() => {
    if (activeTab !== 'logs') return;
    if (!stickToBottomRef.current) return;
    const timer = setTimeout(scrollToBottom, 60);
    return () => clearTimeout(timer);
  }, [logs, activeTab, scrollToBottom]);

  const handleTriggerScan = async () => {
    try {
      setIsTriggeringScan(true);
      setActiveTab('logs');
      const timestamp = new Date().toLocaleTimeString('zh-TW', { hour12: false });
      setLocalNotice(`⏳ 已觸發：連線 fayun.org 執行媒體同步與掃描中…（${timestamp}）`);

      const { ok, data } = await safeFetchJson('/api/scan', { method: 'POST' });
      if (ok) {
        // The trigger message lives in the banner above, so the log buffer is
        // simply the server tail. Appending it here (or prepending to it) either
        // dropped the message on the next poll or duplicated every line.
        if (data.recentLogs) setLogs(data.recentLogs);
        if (data.lastScan) setLastScan(data.lastScan);
        if (data.totalCourses) setTotalCourses(data.totalCourses);

        // Poll until THIS run reports an outcome. 60 iterations x 2.5s = ~150s of
        // progress streaming; the scan itself keeps running in the background
        // regardless, so leaving the loop is purely a UI concern.
        const finished = await pollUntilRunFinishes(data.runId, 60);
        if (!isMountedRef.current) return;
        if (finished) setLocalNotice('');

        if (onRefreshCourses && isMountedRef.current) {
          await onRefreshCourses();
        }
      } else {
        // Surface an actionable cause. The server distinguishes genuine
        // contention (409) from an unusable data directory (503); the latter
        // used to be reported as "already running", which sent users looking
        // for a task that did not exist.
        const hint =
          data.status === 'unavailable'
            ? '（資料目錄無法寫入，請確認 ./data 掛載權限）'
            : data.status === 'busy'
              ? '（請稍候，或檢查是否有殘留的掃描程序）'
              : '';
        setLocalNotice(`❌ 媒體同步失敗：${data.error || '未知錯誤'}${hint}`);
      }
    } catch (e: any) {
      const errorMsg = `[${new Date().toLocaleTimeString('zh-TW', { hour12: false })}] ❌ [系統錯誤] 執行同步出錯: ${e.message}`;
      setLogs((prev) => `${prev}\n${errorMsg}`);
    } finally {
      if (isMountedRef.current) setIsTriggeringScan(false);
    }
  };

  const handleTriggerAutoHeal = async () => {
    try {
      setIsTriggeringHeal(true);
      setActiveTab('logs');
      const timestamp = new Date().toLocaleTimeString('zh-TW', { hour12: false });
      const countLabel = totalCourses || 684;
      setLocalNotice(`⏳ 已觸發：全站 ${countLabel} 門課程巡檢與自我修復中…（${timestamp}）`);

      const { ok, data } = await safeFetchJson('/api/health-check', { method: 'POST' });
      if (ok) {
        // See handleTriggerScan: the trigger message is shown in the banner.
        if (data.recentLogs) setLogs(data.recentLogs);

        // See handleTriggerScan: completion is read from the structured run
        // record, never from the shared log tail.
        const finished = await pollUntilRunFinishes(data.runId, 60);
        if (!isMountedRef.current) return;
        if (finished) setLocalNotice('');

        if (onRefreshCourses && isMountedRef.current) {
          await onRefreshCourses();
        }
      } else {
        const hint =
          data.status === 'unavailable'
            ? '（資料目錄無法寫入，請確認 ./data 掛載權限）'
            : data.status === 'busy'
              ? '（請稍候，或檢查是否有殘留的掃描程序）'
              : '';
        const errorMsg = `[${timestamp}] ❌ [系統錯誤] 巡檢修復失敗: ${data.error || '未知錯誤'}${hint}`;
        setLogs((prev) => `${prev}\n${errorMsg}`);
      }
    } catch (e: any) {
      const errorMsg = `[${new Date().toLocaleTimeString('zh-TW', { hour12: false })}] ❌ [系統錯誤] 執行巡檢修復出錯: ${e.message}`;
      setLogs((prev) => `${prev}\n${errorMsg}`);
    } finally {
      if (isMountedRef.current) setIsTriggeringHeal(false);
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

  // Tracks whether the modal is still mounted; the long-running scan/heal
  // polling loops below must not keep fetching and calling setState after the
  // user closes the dialog.
  //
  // This component is NEVER unmounted on close: page.tsx always renders it and
  // it early-returns `null` on `!isOpen`, so a `[]` effect left this flag true
  // forever and every guard below was a no-op. Closing mid-scan therefore kept
  // hitting /api/scan every 2.5s for up to 150s and refetching the whole 684-row
  // catalog. Folding `isOpen` into the same flag makes "closed" behave like
  // "unmounted", which is what the loops were always meant to stop on.
  const isMountedRef = useRef<boolean>(true);
  useEffect(() => {
    isMountedRef.current = isOpen;
    return () => {
      isMountedRef.current = false;
    };
  }, [isOpen]);

  /** Sleeps in short slices so an unmount can interrupt a long poll loop. */
  const interruptibleSleep = useCallback(async (ms: number) => {
    const step = 250;
    let elapsed = 0;
    while (elapsed < ms) {
      if (!isMountedRef.current) return false;
      await new Promise((r) => setTimeout(r, Math.min(step, ms - elapsed)));
      elapsed += step;
    }
    return isMountedRef.current;
  }, []);

  /**
   * Streams progress until the run identified by `runId` reports an outcome.
   *
   * Returns true when the run finished, false if it is still going when the
   * budget is exhausted.
   */
  const pollUntilRunFinishes = useCallback(
    async (runId: string | undefined, iterations: number): Promise<boolean> => {
      for (let i = 0; i < iterations; i++) {
        if (!(await interruptibleSleep(2500))) return false;
        const latestLogs = await fetchLogs();
        if (!isMountedRef.current) return false;
        if (
          runId &&
          lastRunRef.current &&
          lastRunRef.current.id === runId
        ) {
          return true;
        }
        // Fall back to completion by log line only when the server did not
        // provide an id (older server during a rolling deploy).
        if (!runId && latestLogs && /Finished|Complete/.test(latestLogs)) {
          return true;
        }
      }
      return false;
    },
    [fetchLogs, interruptibleSleep]
  );


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
                    <span className="c-tag">系統版本</span>
                    <span className="c-content">
                      <strong>v{packageInfo.version}</strong> (Zen Modern Edition 禪風現代版)
                    </span>
                  </div>
                  <div className="copyright-line">
                    <span className="c-tag">主機快取容量</span>
                    <span className="c-content">
                      <strong>20 GB</strong> 高速磁碟快取（已啟用 LRU 自動輪替與背景預載，支援 0ms 本地極速串流）
                    </span>
                  </div>
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
                  <span className="stat-label">🧾 最近維護結果</span>
                  <span className="stat-value">
                    {isTaskRunning
                      ? '執行中…'
                      : lastRun
                        ? `${lastRun.ok ? '✅ 成功' : '❌ 失敗'}（${lastRun.task || '-'}）`
                        : '---'}
                  </span>
                </div>
                <div className="stat-card">
                  <span className="stat-label">💾 媒體快取容量</span>
                  <span className="stat-value">
                    {cacheStats ? `${cacheStats.maxGb} GB` : '20 GB'}
                  </span>
                </div>
                <div className="stat-card">
                  <span className="stat-label">⚡ 自動巡檢狀態</span>
                  <span className="stat-value active">連線運作中</span>
                </div>
              </div>

              {/* Task-trigger credential.
                  The scan/heal endpoints spawn Python processes that rewrite
                  the catalog, so they require a token. When TASK_API_TOKEN is
                  unset the server generates one per boot and prints it to
                  scanner.log, so this panel appears exactly when the operator
                  still needs to paste it. */}
              {(needsTaskToken || taskToken) && (
                <div className="task-token-row">
                  <label className="task-token-label" htmlFor="task-token-input">
                    🔑 任務授權碼
                  </label>
                  <input
                    id="task-token-input"
                    className="task-token-input"
                    type="password"
                    value={taskToken}
                    placeholder="貼上啟動日誌中的 X-Task-Token"
                    onChange={(e) => {
                      const next = e.target.value.trim();
                      setTaskToken(next);
                      setStoredTaskToken(next);
                      if (next) setNeedsTaskToken(false);
                    }}
                  />
                  {needsTaskToken && (
                    <span className="task-token-hint">
                      伺服器要求授權碼才能執行掃描／修復。未設定 <code>TASK_API_TOKEN</code> 時，
                      啟動時會自動產生一組並寫入日誌，請複製貼上。
                    </span>
                  )}
                </div>
              )}

              {/* Action Toolbar with Tooltips */}
              <div className="log-action-toolbar">
                <div className="tooltip-action-wrapper" data-tooltip="連線 fayun.org 掃描新上架之佛法經論、禪修開示與音訊影音媒體資源">
                  <button
                    className="log-sync-btn"
                    onClick={handleTriggerScan}
                    disabled={isTriggeringScan || isTriggeringHeal || isFetchingLogs || isTaskRunning}
                    title="連線 fayun.org 掃描新上架之佛法經論、禪修開示與音訊影音媒體資源"
                  >
                    {isTriggeringScan ? '⏳ 正在掃描同步中...' : '🔄 同步新媒體'}
                  </button>
                </div>

                <div className="tooltip-action-wrapper" data-tooltip="自動檢測全站所有課程之音訊、影音與 PDF 講義鏈結，發現無效網址自動校正修復">
                  <button
                    className="log-heal-btn"
                    onClick={handleTriggerAutoHeal}
                    disabled={isTriggeringHeal || isTriggeringScan || isFetchingLogs || isTaskRunning}
                    title="自動檢測全站所有課程之音訊、影音與 PDF 講義鏈結，發現無效網址自動校正修復"
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
                    disabled={isFetchingLogs || isTriggeringScan || isTriggeringHeal || isTaskRunning}
                    title="從網頁伺服器重新載入最新 scanner.log 內容"
                  >
                    🔄 重新整理日誌
                  </button>
                </div>
              </div>

              {/* Transient trigger/error notice: kept out of the log text so a
                  poll cannot erase it and repeated polls cannot duplicate it. */}
              {localNotice && (
                <div className="log-notice-bar" role="status">
                  <span>{localNotice}</span>
                  <button
                    type="button"
                    className="log-notice-dismiss"
                    onClick={() => setLocalNotice('')}
                    aria-label="關閉通知"
                  >
                    ✕
                  </button>
                </div>
              )}

              {/* Log Display Window */}
              <div className="log-window-wrapper">
                <div className="log-window-header">
                  <span className="log-file-tag">📄 scanner.log</span>
                  <span className="log-hint">
                    紀錄 fayun.org 媒體掃描、新上架與路徑自我修復歷史資訊（每 3 秒自動更新，自動跳至最新）
                  </span>
                </div>
                <pre className="log-window-body" ref={logBodyRef} onScroll={handleLogScroll}>
                  {logs}
                </pre>
              </div>
            </div>
          )}
        </div>

        <div className="settings-modal-footer">
          <div className="settings-version-tag">
            <span className="settings-version-label">法雲資訊網典藏系統</span>
            <span className="settings-version-badge">v{packageInfo.version}</span>
          </div>
          <button className="settings-save-btn" onClick={onClose}>
            完成設定
          </button>
        </div>
      </div>
    </div>
  );
}
