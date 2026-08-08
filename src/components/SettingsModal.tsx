'use client';

import React from 'react';
import { ThemeType } from '@/types/course';

export type FontSizeScale = 'small' | 'normal' | 'large' | 'xlarge';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  theme: ThemeType;
  onSelectTheme: (theme: ThemeType) => void;
  fontSize: FontSizeScale;
  onSelectFontSize: (size: FontSizeScale) => void;
}

export default function SettingsModal({
  isOpen,
  onClose,
  theme,
  onSelectTheme,
  fontSize,
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
                className={`theme-option-btn lotus ${theme === 'lotus' ? 'active' : ''}`}
                onClick={() => onSelectTheme('lotus')}
              >
                <span className="theme-icon">🪷</span>
                <span className="theme-name">紫蓮靜室</span>
                <span className="theme-tag">紫藕</span>
              </button>
            </div>
          </div>

          {/* Font Size Section */}
          <div className="settings-section">
            <h4 className="settings-section-title">🔤 文字顯示大小 (Font Size)</h4>
            <p className="settings-section-desc">動態調整全站經論名稱、講義內容與目錄之字型大小</p>

            <div className="font-size-segmented-control">
              <button
                className={`font-size-btn ${fontSize === 'small' ? 'active' : ''}`}
                onClick={() => onSelectFontSize('small')}
              >
                <span className="font-btn-label font-size-sample-sm">小</span>
                <span className="font-btn-val">14px</span>
              </button>

              <button
                className={`font-size-btn ${fontSize === 'normal' ? 'active' : ''}`}
                onClick={() => onSelectFontSize('normal')}
              >
                <span className="font-btn-label font-size-sample-md">標準</span>
                <span className="font-btn-val">16px</span>
              </button>

              <button
                className={`font-size-btn ${fontSize === 'large' ? 'active' : ''}`}
                onClick={() => onSelectFontSize('large')}
              >
                <span className="font-btn-label font-size-sample-lg">大</span>
                <span className="font-btn-val">18px</span>
              </button>

              <button
                className={`font-size-btn ${fontSize === 'xlarge' ? 'active' : ''}`}
                onClick={() => onSelectFontSize('xlarge')}
              >
                <span className="font-btn-label font-size-sample-xl">特大</span>
                <span className="font-btn-val">20px</span>
              </button>
            </div>

            {/* Live Text Preview Box */}
            <div className="font-size-preview-box">
              <span className="preview-tag">即時預覽：</span>
              <p className="preview-text">
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
