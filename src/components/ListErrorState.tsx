'use client';

import React from 'react';

/**
 * Shown in place of a list whose discovery request failed.
 *
 * Deliberately distinct from the "no files" empty state: one means "reload may
 * fix this", the other means "there is nothing here". `role="alert"` so the
 * message is announced when it replaces a spinner.
 */
export default function ListErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="list-error-state" role="alert">
      <span className="list-error-icon" aria-hidden="true">⚠️</span>
      <p className="list-error-message">{message}</p>
      <p className="list-error-hint">請確認網路連線後重試；若持續失敗，可能是伺服器暫時無法存取典藏目錄。</p>
      <button type="button" className="list-error-retry" onClick={onRetry}>
        重新載入
      </button>
    </div>
  );
}
