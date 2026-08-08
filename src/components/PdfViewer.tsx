'use client';

import React, { useState } from 'react';
import { PdfItem } from '@/types/course';

interface PdfViewerProps {
  pdfs: PdfItem[];
  courseTitle: string;
}

export default function PdfViewer({ pdfs, courseTitle }: PdfViewerProps) {
  const [selectedPdfIndex, setSelectedPdfIndex] = useState<number>(0);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  if (!pdfs || pdfs.length === 0) {
    return (
      <div className="pdf-empty-card">
        <span className="empty-icon">📖</span>
        <p>此課程目前無提供 PDF 講義/筆記檔案。</p>
      </div>
    );
  }

  const activePdf = pdfs[selectedPdfIndex] || pdfs[0];
  const proxyUrl = `/api/proxy?url=${encodeURIComponent(activePdf.url)}`;

  return (
    <div className={`pdf-viewer-card ${isFullscreen ? 'fullscreen-mode' : ''}`}>
      <div className="pdf-header-bar">
        <div className="pdf-selector">
          <span className="pdf-label">📄 講義筆記：</span>
          <select
            value={selectedPdfIndex}
            onChange={(e) => setSelectedPdfIndex(Number(e.target.value))}
            className="pdf-dropdown"
          >
            {pdfs.map((pdf, i) => (
              <option key={i} value={i}>
                {pdf.filename || `講義筆記 ${pdf.num || i + 1}`}
              </option>
            ))}
          </select>
          <span className="pdf-count">({pdfs.length} 份文件)</span>
        </div>

        <div className="pdf-actions">
          <a
            href={proxyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="pdf-btn-secondary"
            title="新分頁開啟 PDF"
          >
            ↗️ 新分頁開啟
          </a>
          <a
            href={proxyUrl}
            download={activePdf.filename}
            className="pdf-btn-primary"
            title="下載 PDF"
          >
            ⬇️ 下載 PDF
          </a>
          <button
            onClick={() => setIsFullscreen(!isFullscreen)}
            className="pdf-btn-icon"
            title={isFullscreen ? '退出全螢幕' : '全螢幕預覽'}
          >
            {isFullscreen ? '✕ 關閉' : '⛶ 全螢幕'}
          </button>
        </div>
      </div>

      <div className="pdf-frame-container">
        <iframe
          src={`${proxyUrl}#toolbar=1&navpanes=1`}
          title={activePdf.filename || courseTitle}
          className="pdf-iframe"
        />
      </div>
    </div>
  );
}
