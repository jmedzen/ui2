'use client';

import React, { useState } from 'react';

import {
  MAX_ADMIN_PASSWORD_LENGTH,
  MIN_ADMIN_PASSWORD_LENGTH
} from '@/lib/passwordPolicy';

interface AdminFetchResponse {
  ok: boolean;
  status: number;
  data: unknown;
}

type AdminFetch = (url: string, options?: RequestInit) => Promise<AdminFetchResponse>;

interface AdminSecurityPanelProps {
  passwordChangeable: boolean;
  totpEnabled: boolean;
  totpManageable: boolean;
  fetcher: AdminFetch;
  onSessionChanged: () => Promise<void>;
  onNotice: (message: string) => void;
}

type TotpMode = 'idle' | 'setup' | 'disable';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function messageFrom(data: unknown, fallback: string): string {
  const error = record(data).error;
  return typeof error === 'string' && error ? error : fallback;
}

function codeFrom(data: unknown): string {
  const code = record(data).code;
  return typeof code === 'string' ? code : '';
}

function statusMessage(status: number, data: unknown, fallback: string): string {
  const code = codeFrom(data);
  if (status === 429) return '嘗試次數過多，請稍後再試。';
  if (status === 403) return '請求遭到拒絕（來源或 CSRF 驗證失敗），請重新整理頁面。';
  if (status === 401 && (code === 'ADMIN_TOTP_REQUIRED' || code === 'ADMIN_BAD_TOTP' || code === 'ADMIN_TOTP_REPLAY')) {
    return code === 'ADMIN_TOTP_REPLAY'
      ? '此驗證碼已使用過，請等待下一個驗證碼。'
      : code === 'ADMIN_BAD_TOTP'
        ? '驗證碼不正確。'
        : '請輸入驗證器目前的 6 位數驗證碼。';
  }
  if (code === 'ADMIN_PASSWORD_MANAGED_EXTERNALLY') {
    return '此部署的密碼由環境變數或唯讀憑證檔管理，無法從網頁修改。';
  }
  if (code === 'ADMIN_TOTP_MANAGED_EXTERNALLY') {
    return '此部署的 TOTP 由 ADMIN_TOTP_SECRET 管理，無法從網頁修改。';
  }
  return messageFrom(data, fallback);
}

export default function AdminSecurityPanel({
  passwordChangeable,
  totpEnabled,
  totpManageable,
  fetcher,
  onSessionChanged,
  onNotice
}: AdminSecurityPanelProps) {
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordCode, setPasswordCode] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [isChangingPassword, setIsChangingPassword] = useState(false);

  const [totpMode, setTotpMode] = useState<TotpMode>('idle');
  const [setupSecret, setSetupSecret] = useState('');
  const [setupUri, setSetupUri] = useState('');
  const [setupCode, setSetupCode] = useState('');
  const [setupPassword, setSetupPassword] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [disablePassword, setDisablePassword] = useState('');
  const [totpError, setTotpError] = useState('');
  const [totpNotice, setTotpNotice] = useState('');
  const [totpBusy, setTotpBusy] = useState(false);
  const [copiedField, setCopiedField] = useState<'secret' | 'uri' | ''>('');

  const resetPasswordForm = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setPasswordCode('');
    setPasswordError('');
  };

  const resetTotpPanel = () => {
    setTotpMode('idle');
    setSetupSecret('');
    setSetupUri('');
    setSetupCode('');
    setSetupPassword('');
    setDisableCode('');
    setDisablePassword('');
    setTotpError('');
    setCopiedField('');
  };

  const handlePasswordChange = async (event: React.FormEvent) => {
    event.preventDefault();
    setPasswordError('');

    if (!currentPassword) {
      setPasswordError('請輸入目前密碼。');
      return;
    }
    if (newPassword.length < MIN_ADMIN_PASSWORD_LENGTH) {
      setPasswordError(`新密碼至少需要 ${MIN_ADMIN_PASSWORD_LENGTH} 個字元。`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('兩次輸入的新密碼不一致。');
      return;
    }
    if (totpEnabled && !passwordCode.trim()) {
      setPasswordError('請輸入驗證器目前的 6 位數驗證碼。');
      return;
    }

    setIsChangingPassword(true);
    try {
      const result = await fetcher('/api/admin/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword,
          newPassword,
          ...(passwordCode.trim() ? { code: passwordCode.trim() } : {})
        })
      });
      const data = record(result.data);

      if (result.ok) {
        resetPasswordForm();
        setShowPasswordForm(false);
        onNotice('✅ 管理員密碼已更新；其他工作階段已立即失效。');
        await onSessionChanged();
        return;
      }

      if (result.status === 401 && codeFrom(data) === 'ADMIN_LOGIN_REQUIRED') {
        resetPasswordForm();
        setShowPasswordForm(false);
        await onSessionChanged();
      }
      setPasswordError(statusMessage(result.status, data, '密碼變更失敗。'));
    } finally {
      setIsChangingPassword(false);
    }
  };

  const startTotpSetup = async () => {
    setTotpError('');
    setTotpNotice('');
    setTotpBusy(true);
    try {
      const result = await fetcher('/api/admin/totp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'setup' })
      });
      const data = record(result.data);
      if (!result.ok) {
        setTotpError(statusMessage(result.status, data, '無法開始 TOTP 設定。'));
        await onSessionChanged();
        return;
      }

      const secret = typeof data.secret === 'string' ? data.secret : '';
      const uri = typeof data.otpauthUri === 'string' ? data.otpauthUri : '';
      if (!secret || !uri) {
        setTotpError('伺服器未回傳有效的 TOTP 設定資料。');
        return;
      }

      setSetupSecret(secret);
      setSetupUri(uri);
      setSetupCode('');
      setSetupPassword('');
      setTotpMode('setup');
    } finally {
      setTotpBusy(false);
    }
  };

  const handleEnableTotp = async (event: React.FormEvent) => {
    event.preventDefault();
    setTotpError('');
    if (!setupPassword) {
      setTotpError('請輸入目前的管理員密碼。');
      return;
    }
    if (setupCode.trim().length !== 6) {
      setTotpError('請輸入 6 位數驗證碼。');
      return;
    }

    setTotpBusy(true);
    try {
      const result = await fetcher('/api/admin/totp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'enable',
          secret: setupSecret,
          code: setupCode.trim(),
          password: setupPassword
        })
      });
      const data = record(result.data);
      if (!result.ok) {
        setTotpError(statusMessage(result.status, data, '無法啟用 TOTP。'));
        return;
      }

      resetTotpPanel();
      setTotpNotice('✅ TOTP 雙因素驗證已啟用。下次登入需要驗證碼。');
      onNotice('✅ TOTP 雙因素驗證已啟用。');
      await onSessionChanged();
    } finally {
      setTotpBusy(false);
    }
  };

  const handleDisableTotp = async (event: React.FormEvent) => {
    event.preventDefault();
    setTotpError('');
    if (!disablePassword) {
      setTotpError('請輸入目前的管理員密碼。');
      return;
    }
    if (disableCode.trim().length !== 6) {
      setTotpError('請輸入 6 位數驗證碼。');
      return;
    }

    setTotpBusy(true);
    try {
      const result = await fetcher('/api/admin/totp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'disable',
          code: disableCode.trim(),
          password: disablePassword
        })
      });
      const data = record(result.data);
      if (!result.ok) {
        setTotpError(statusMessage(result.status, data, '無法停用 TOTP。'));
        return;
      }

      resetTotpPanel();
      setTotpNotice('TOTP 雙因素驗證已停用。');
      onNotice('TOTP 雙因素驗證已停用。');
      await onSessionChanged();
    } finally {
      setTotpBusy(false);
    }
  };

  const copyText = async (field: 'secret' | 'uri', value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      setTimeout(() => setCopiedField(''), 2000);
    } catch {
      setTotpError('無法存取剪貼簿，請手動選取內容。');
    }
  };

  return (
    <div className="admin-security-panel">
      <div className="admin-security-heading">
        <span>🔐 帳號安全</span>
        <span className="admin-security-hint">變更密碼與雙因素驗證</span>
      </div>

      {!passwordChangeable ? (
        <p className="admin-auth-note">
          目前密碼由 <code>ADMIN_PASSWORD_HASH</code>、<code>ADMIN_PASSWORD_HASH_FILE</code>
          或唯讀掛載管理，無法從網頁修改。
        </p>
      ) : !showPasswordForm ? (
        <div className="admin-security-row">
          <span className="admin-auth-note">定期更換管理員密碼，變更後其他工作階段會立即失效。</span>
          <button
            type="button"
            className="admin-secondary-btn"
            onClick={() => {
              setPasswordError('');
              setShowPasswordForm(true);
            }}
          >
            🔑 變更密碼
          </button>
        </div>
      ) : (
        <form className="admin-password-form" onSubmit={handlePasswordChange}>
          <div className="admin-password-grid">
            <label className="admin-password-field">
              <span>目前密碼</span>
              <input
                className="admin-login-input"
                type="password"
                autoComplete="current-password"
                maxLength={MAX_ADMIN_PASSWORD_LENGTH}
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                disabled={isChangingPassword}
              />
            </label>
            <label className="admin-password-field">
              <span>新密碼（至少 {MIN_ADMIN_PASSWORD_LENGTH} 字元）</span>
              <input
                className="admin-login-input"
                type="password"
                autoComplete="new-password"
                maxLength={MAX_ADMIN_PASSWORD_LENGTH}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                disabled={isChangingPassword}
              />
            </label>
            <label className="admin-password-field">
              <span>確認新密碼</span>
              <input
                className="admin-login-input"
                type="password"
                autoComplete="new-password"
                maxLength={MAX_ADMIN_PASSWORD_LENGTH}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                disabled={isChangingPassword}
              />
            </label>
            {totpEnabled && (
              <label className="admin-password-field">
                <span>TOTP 驗證碼</span>
                <input
                  className="admin-login-input admin-code-input"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={passwordCode}
                  onChange={(event) => setPasswordCode(event.target.value.replace(/\D/g, ''))}
                  disabled={isChangingPassword}
                  placeholder="6 位數"
                />
              </label>
            )}
          </div>
          <div className="admin-password-actions">
            <button type="submit" className="admin-login-btn" disabled={isChangingPassword}>
              {isChangingPassword ? '更新中…' : '確認變更'}
            </button>
            <button
              type="button"
              className="admin-secondary-btn"
              onClick={() => {
                resetPasswordForm();
                setShowPasswordForm(false);
              }}
              disabled={isChangingPassword}
            >
              取消
            </button>
          </div>
          {passwordError && (
            <div className="admin-login-error" role="alert">
              {passwordError}
            </div>
          )}
        </form>
      )}

      <div className="admin-security-divider" />

      <div className="admin-security-row">
        <span>
          <strong>雙因素驗證（TOTP）：</strong>
          {totpEnabled ? '已啟用' : '未啟用'}
        </span>
        {!totpManageable ? (
          <span className="admin-auth-note">
            {totpEnabled
              ? '由部署環境管理，無法從網頁停用。'
              : '此部署無法從網頁啟用 TOTP。'}
          </span>
        ) : totpMode === 'idle' ? (
          totpEnabled ? (
            <button
              type="button"
              className="admin-secondary-btn"
              onClick={() => {
                setTotpError('');
                setTotpNotice('');
                setDisableCode('');
                setDisablePassword('');
                setTotpMode('disable');
              }}
            >
              停用 TOTP
            </button>
          ) : (
            <button
              type="button"
              className="admin-secondary-btn"
              onClick={startTotpSetup}
              disabled={totpBusy}
            >
              {totpBusy ? '準備中…' : '啟用 TOTP'}
            </button>
          )
        ) : null}
      </div>

      {totpMode === 'setup' && (
        <form className="admin-totp-setup" onSubmit={handleEnableTotp}>
          <p className="admin-auth-note">
            請在驗證器 App（Google Authenticator、1Password、Aegis 等）手動加入下列密鑰，
            或貼上 otpauth URI。驗證器會每 30 秒產生一組 6 位數驗證碼。
          </p>
          <div className="admin-totp-secret">
            <span>密鑰</span>
            <code>{setupSecret}</code>
            <button
              type="button"
              className="admin-secondary-btn"
              onClick={() => copyText('secret', setupSecret)}
            >
              {copiedField === 'secret' ? '已複製' : '複製'}
            </button>
          </div>
          <div className="admin-totp-secret">
            <span>otpauth URI</span>
            <code>{setupUri}</code>
            <button
              type="button"
              className="admin-secondary-btn"
              onClick={() => copyText('uri', setupUri)}
            >
              {copiedField === 'uri' ? '已複製' : '複製'}
            </button>
          </div>
          <div className="admin-password-grid">
            <label className="admin-password-field">
              <span>驗證器目前的 6 位數驗證碼</span>
              <input
                className="admin-login-input admin-code-input"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={setupCode}
                onChange={(event) => setSetupCode(event.target.value.replace(/\D/g, ''))}
                disabled={totpBusy}
                placeholder="000000"
              />
            </label>
            <label className="admin-password-field">
              <span>目前管理員密碼</span>
              <input
                className="admin-login-input"
                type="password"
                autoComplete="current-password"
                maxLength={MAX_ADMIN_PASSWORD_LENGTH}
                value={setupPassword}
                onChange={(event) => setSetupPassword(event.target.value)}
                disabled={totpBusy}
              />
            </label>
          </div>
          <div className="admin-password-actions">
            <button type="submit" className="admin-login-btn" disabled={totpBusy}>
              {totpBusy ? '啟用中…' : '確認啟用'}
            </button>
            <button
              type="button"
              className="admin-secondary-btn"
              onClick={resetTotpPanel}
              disabled={totpBusy}
            >
              取消
            </button>
          </div>
          {totpError && (
            <div className="admin-login-error" role="alert">
              {totpError}
            </div>
          )}
        </form>
      )}

      {totpMode === 'disable' && (
        <form className="admin-totp-setup" onSubmit={handleDisableTotp}>
          <p className="admin-auth-note">
            停用後登入將只需要密碼。若驗證器遺失，也可在伺服器執行
            <code> node scripts/admin-password.mjs --disable-totp</code> 復原。
          </p>
          <div className="admin-password-grid">
            <label className="admin-password-field">
              <span>目前 6 位數驗證碼</span>
              <input
                className="admin-login-input admin-code-input"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={disableCode}
                onChange={(event) => setDisableCode(event.target.value.replace(/\D/g, ''))}
                disabled={totpBusy}
                placeholder="000000"
              />
            </label>
            <label className="admin-password-field">
              <span>目前管理員密碼</span>
              <input
                className="admin-login-input"
                type="password"
                autoComplete="current-password"
                maxLength={MAX_ADMIN_PASSWORD_LENGTH}
                value={disablePassword}
                onChange={(event) => setDisablePassword(event.target.value)}
                disabled={totpBusy}
              />
            </label>
          </div>
          <div className="admin-password-actions">
            <button type="submit" className="admin-login-btn" disabled={totpBusy}>
              {totpBusy ? '停用中…' : '確認停用'}
            </button>
            <button
              type="button"
              className="admin-secondary-btn"
              onClick={resetTotpPanel}
              disabled={totpBusy}
            >
              取消
            </button>
          </div>
          {totpError && (
            <div className="admin-login-error" role="alert">
              {totpError}
            </div>
          )}
        </form>
      )}

      {totpNotice && (
        <div className="admin-success-note" role="status">
          {totpNotice}
        </div>
      )}
    </div>
  );
}
