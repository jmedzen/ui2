'use client';

import React, { useState } from 'react';

interface AdminFetchResponse {
  ok: boolean;
  status: number;
  data: unknown;
}

type AdminFetch = (url: string, options?: RequestInit) => Promise<AdminFetchResponse>;

interface SiteUrlPanelProps {
  /** Current origin, already fetched with the session payload. */
  siteUrl: string;
  source: 'environment' | 'settings' | 'default';
  /** True when SITE_URL in the environment wins and this panel cannot write. */
  locked: boolean;
  fetcher: AdminFetch;
  onSaved: (siteUrl: string, source: 'environment' | 'settings' | 'default') => void;
  onNotice: (message: string) => void;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function sourceOf(value: unknown): 'environment' | 'settings' | 'default' {
  return value === 'environment' || value === 'settings' ? value : 'default';
}

/**
 * Canonical URL editor.
 *
 * The origin here becomes `<link rel="canonical">`, `og:url` and the base of the
 * absolute og:image, so a wrong value breaks every share preview without any
 * visible error. The panel therefore always states where the current value came
 * from, and goes read-only when SITE_URL pins it -- saving in that state would
 * appear to succeed while changing nothing.
 *
 * Purely presentational: the value arrives with the session payload and changes
 * are reported back through `onSaved`, so this component needs no effect of its
 * own.
 */
export default function SiteUrlPanel({
  siteUrl,
  source,
  locked,
  fetcher,
  onSaved,
  onNotice
}: SiteUrlPanelProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const startEditing = () => {
    setDraft(siteUrl);
    setError('');
    setEditing(true);
  };

  const submit = async (payload: Record<string, unknown>, successMessage: string) => {
    setError('');
    setBusy(true);
    try {
      const result = await fetcher('/api/admin/site-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = record(result.data);

      if (result.ok) {
        onSaved(text(data.siteUrl), sourceOf(data.source));
        setEditing(false);
        onNotice(successMessage);
        return;
      }

      setError(
        result.status === 409
          ? '此部署以 SITE_URL 環境變數固定網址，請先移除該變數才能從這裡設定。'
          : text(data.error) || '儲存失敗。'
      );
    } finally {
      setBusy(false);
    }
  };

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.trim()) {
      setError('請輸入網址，例如 https://ui2.mahabodhi.co');
      return;
    }
    void submit(
      { siteUrl: draft.trim() },
      '✅ 網站網址已更新；社群平台重新抓取後分享預覽就會更新。'
    );
  };

  const sourceLabel =
    source === 'environment'
      ? '由環境變數 SITE_URL 指定'
      : source === 'settings'
        ? '由本頁設定儲存'
        : '使用內建預設值';

  return (
    <div className="admin-security-panel">
      <div className="admin-security-heading">
        <span>🌐 網站網址</span>
        <span className="admin-security-hint">canonical 與分享預覽</span>
      </div>

      {!editing ? (
        <>
          <div className="admin-site-url-value">
            <code>{siteUrl}</code>
          </div>
          <p className="admin-auth-note">
            {sourceLabel}。社群平台會以此網址產生分享卡片的 <code>og:url</code> 與圖片絕對路徑；
            設定錯誤不會報錯，只會讓預覽失效。
          </p>
          <div className="admin-security-row">
            <span className="admin-auth-note">
              {locked ? '環境變數優先，此處無法覆寫。' : '變更後不需重啟。'}
            </span>
            <div className="admin-site-url-actions">
              <button
                type="button"
                className="admin-secondary-btn"
                onClick={startEditing}
                disabled={locked || busy}
              >
                ✏️ 變更網址
              </button>
              {source === 'settings' && (
                <button
                  type="button"
                  className="admin-secondary-btn"
                  onClick={() => void submit({ reset: true }, '✅ 已還原為預設網址。')}
                  disabled={busy}
                >
                  ↺ 還原預設
                </button>
              )}
            </div>
          </div>
        </>
      ) : (
        <form className="admin-password-form" onSubmit={save}>
          <label className="admin-password-field">
            <span>網站網址（含 https://，不要填路徑）</span>
            <input
              className="admin-login-input"
              type="text"
              inputMode="url"
              autoComplete="url"
              placeholder="https://ui2.mahabodhi.co"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              disabled={busy}
            />
          </label>
          {error && <p className="admin-login-error">{error}</p>}
          <div className="admin-security-row">
            <span className="admin-auth-note">
              這只影響 canonical 與分享預覽，不會改變伺服器實際監聽的網域。
            </span>
            <div className="admin-site-url-actions">
              <button
                type="button"
                className="admin-secondary-btn"
                onClick={() => setEditing(false)}
                disabled={busy}
              >
                取消
              </button>
              <button type="submit" className="admin-login-btn" disabled={busy}>
                {busy ? '儲存中…' : '儲存'}
              </button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}
