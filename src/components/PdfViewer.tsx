// Lazy PDF.js viewer (M6): renders a single page to a <canvas> with a toolbar
// for paging, zoom, and fit-to-width. Per-file page/zoom is persisted in the
// preview store so reopening a PDF restores its last view.

import { useEffect, useRef, useState } from "react";
import type {
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from "pdfjs-dist/types/src/display/api";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import { readFileBytes } from "../lib/ipc";
import { usePreviewStore } from "../state/previewStore";
import { clampPage, clampZoom, zoomIn, zoomOut } from "../lib/pdf";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export default function PdfViewer({ path }: { path: string }) {
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // The currently rendered page proxy, released when navigating to another page
  // so pdf.js does not accumulate per-page operator lists for the doc's lifetime.
  const lastPageRef = useRef<PDFPageProxy | null>(null);

  const saved = usePreviewStore.getState().viewState[path];
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(saved?.page ?? 1);
  const [zoom, setZoom] = useState(saved?.zoom ?? 1);
  // A fatal load error replaces the whole viewer; a render error is transient and
  // shown inline so the toolbar stays usable (the user can page/zoom to recover).
  const [loadError, setLoadError] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    (async () => {
      try {
        const data = await readFileBytes(path);
        const pdf = await pdfjsLib.getDocument({ data }).promise;
        if (cancelled) {
          void pdf.destroy();
          return;
        }
        docRef.current = pdf;
        setDoc(pdf);
        setNumPages(pdf.numPages);
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
      // Release the PDF document (and its worker resources) on unmount/reload.
      void docRef.current?.destroy();
      docRef.current = null;
      lastPageRef.current = null;
    };
  }, [path]);

  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    setRenderError(null);
    (async () => {
      try {
        const pdfPage = await doc.getPage(page);
        if (cancelled) return;
        // Release the page we navigated away from (no-op on zoom changes, where
        // getPage returns the same cached proxy).
        if (lastPageRef.current && lastPageRef.current !== pdfPage) {
          lastPageRef.current.cleanup();
        }
        lastPageRef.current = pdfPage;
        const viewport = pdfPage.getViewport({ scale: zoom });
        const canvas = canvasRef.current;
        if (!canvas) return;
        const canvasContext = canvas.getContext("2d");
        if (!canvasContext) return;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        task = pdfPage.render({ canvasContext, viewport });
        await task.promise;
      } catch (e) {
        if (!cancelled) {
          setRenderError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    usePreviewStore.getState().setViewState(path, { page, zoom });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page, zoom, path]);

  const fitWidth = async () => {
    if (!doc) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    try {
      const pdfPage = await doc.getPage(page);
      const base = pdfPage.getViewport({ scale: 1 });
      if (base.width <= 0) return;
      setZoom(clampZoom(wrap.clientWidth / base.width));
    } catch (e) {
      setRenderError(e instanceof Error ? e.message : String(e));
    }
  };

  if (loadError) {
    return (
      <div className="pdf-viewer">
        <div className="pdf-error">Failed to load PDF: {loadError}</div>
      </div>
    );
  }

  return (
    <div className="pdf-viewer">
      <div className="pdf-toolbar">
        <button
          type="button"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => setPage(clampPage(page - 1, numPages))}
        >
          Prev
        </button>
        <span className="pdf-page-indicator">
          {page} / {numPages}
        </span>
        <button
          type="button"
          aria-label="Next page"
          disabled={page >= numPages}
          onClick={() => setPage(clampPage(page + 1, numPages))}
        >
          Next
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          onClick={() => setZoom(zoomOut(zoom))}
        >
          -
        </button>
        <span className="pdf-zoom-indicator">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          aria-label="Zoom in"
          onClick={() => setZoom(zoomIn(zoom))}
        >
          +
        </button>
        <button type="button" aria-label="Fit width" onClick={fitWidth}>
          Fit width
        </button>
      </div>
      {renderError && (
        <div className="pdf-error pdf-error-inline" role="alert">
          Failed to render page: {renderError}
        </div>
      )}
      <div ref={wrapRef} className="pdf-canvas-wrap">
        <canvas ref={canvasRef} className="pdf-canvas" />
      </div>
    </div>
  );
}
