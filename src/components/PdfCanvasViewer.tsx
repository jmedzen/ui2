'use client';

import React, { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

interface PdfCanvasViewerProps {
  url: string;
  title: string;
}

/** Pages are rendered once they are within this distance of the viewport. */
const RENDER_MARGIN = '1500px 0px';
/** Cap on device pixel ratio: a 2x canvas is sharp enough and bounds iOS memory. */
const MAX_DPR = 2;

function PdfPage({
  doc,
  pageNumber,
  width,
  ratio
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  width: number;
  ratio: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setVisible(entry.isIntersecting);
      },
      { rootMargin: RENDER_MARGIN }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Draw while near the viewport and release the bitmap when far away, so a
  // 393-page document never holds hundreds of canvases (iOS kills the tab).
  useEffect(() => {
    if (!visible || !width) return;
    let cancelled = false;
    let task: RenderTask | undefined;
    const canvas = canvasRef.current;

    (async () => {
      const page = await doc.getPage(pageNumber);
      if (cancelled || !canvas) return;
      const base = page.getViewport({ scale: 1 });
      const cssScale = width / base.width;
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const viewport = page.getViewport({ scale: cssScale * dpr });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${Math.floor(base.height * cssScale)}px`;
      setMeasuredHeight(Math.floor(base.height * cssScale));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas unavailable');
      task = page.render({ canvas, canvasContext: ctx, viewport });
      await task.promise;
      page.cleanup();
    })().catch((e: unknown) => {
      if ((e as { name?: string })?.name === 'RenderingCancelledException') return;
      if (!cancelled) setFailed(true);
    });

    return () => {
      cancelled = true;
      task?.cancel();
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    };
  }, [visible, width, doc, pageNumber]);

  const height = measuredHeight ?? Math.round(width * ratio);

  return (
    <div
      ref={wrapRef}
      className="pdf-canvas-page"
      style={{ width, height }}
      data-page={pageNumber}
      aria-label={`第 ${pageNumber} 頁`}
    >
      {failed ? <span className="pdf-canvas-page-error">第 {pageNumber} 頁載入失敗</span> : <canvas ref={canvasRef} width={0} height={0} />}
    </div>
  );
}

/**
 * Renders every page of a PDF into canvases with pdf.js.
 *
 * Used where the browser's own viewer cannot be embedded: iOS/iPadOS WebKit
 * shows only page 1 of a PDF inside an <iframe>. Pages are drawn lazily, so a
 * long document stays responsive. The document is fetched through same-origin
 * `/api/proxy`, using HTTP range requests when the server offers them.
 * Mount with `key={url}` so switching documents starts from a clean state.
 */
export default function PdfCanvasViewer({ url, title }: PdfCanvasViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState('');
  const [width, setWidth] = useState(0);
  const [ratio, setRatio] = useState(Math.SQRT2);

  useEffect(() => {
    let cancelled = false;
    let loading: { destroy: () => Promise<void> } | undefined;
    let loaded: PDFDocumentProxy | undefined;

    (async () => {
      const pdfjs = await import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url
      ).toString();
      const task = pdfjs.getDocument({ url });
      loading = task;
      const pdf = await task.promise;
      loaded = pdf;
      if (cancelled) return;
      const first = await pdf.getPage(1);
      const vp = first.getViewport({ scale: 1 });
      if (cancelled) return;
      setRatio(vp.height / vp.width);
      setDoc(pdf);
    })().catch((e: unknown) => {
      if (!cancelled) setError((e as Error)?.message || String(e));
    });

    return () => {
      cancelled = true;
      void (loaded ? loaded.destroy() : loading?.destroy())?.catch?.(() => {});
    };
  }, [url]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(0, Math.floor(el.clientWidth - 2)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={containerRef} className="pdf-canvas-viewer" aria-label={title}>
      {error ? (
        <div className="pdf-canvas-status">
          無法載入 PDF（{error}）。
          <a href={url} target="_blank" rel="noopener noreferrer" className="pdf-btn-primary">
            開啟 PDF
          </a>
        </div>
      ) : !doc ? (
        <div className="pdf-canvas-status">PDF 載入中…</div>
      ) : (
        <>
          <div className="pdf-canvas-count">共 {doc.numPages} 頁</div>
          {Array.from({ length: doc.numPages }, (_, i) => (
            <PdfPage key={i + 1} doc={doc} pageNumber={i + 1} width={width} ratio={ratio} />
          ))}
        </>
      )}
    </div>
  );
}
