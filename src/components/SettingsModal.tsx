'use client';

import React from 'react';
import { ThemeType } from '@/types/course';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  theme: ThemeType;
  onSelectTheme: (theme: ThemeType) => void;
  fontSizePx: number;
  onSelectFontSize: (sizePx: number) => void;
}

export default function SettingsModal({
  isOpen,
  onClose,
  theme,
  onSelectTheme,
  fontSizePx,
  onSelectFontSize
}: SettingsModalProps) {
  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="settings-modal-card shadow-card" onClick={(e) => e.stopPropagation()}>
        <div className="settings-modal-header">
          <h3 className="settings-modal-title">⚙️ 系統偏好設定</h3>
          <button className="settings-modal-close" onClick={onClose} title="關閉">
            ✕
          </button>
        </div>

        <div className="settings-modal-body">
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
