// Lazy PDF.js viewer (M6): renders a single page to a <canvas> with a toolbar
// for paging, zoom, and fit-to-width. Per-file page/zoom is persisted in the
// preview store so reopening a PDF restores its last view.

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from "pdfjs-dist/types/src/display/api";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import { readFileBytes } from "../lib/ipc";
import { usePreviewStore } from "../state/previewStore";
import {
  clampPage,
  clampZoom,
  zoomFromWheel,
  zoomIn,
  zoomOut,
} from "../lib/pdf";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

type TextLayerRender = {
  cancel: () => void;
  render: () => Promise<unknown>;
};

type WebKitGestureEvent = Event & {
  scale?: number;
};

export default function PdfViewer({ path }: { path: string }) {
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pageLayerRef = useRef<HTMLDivElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const gestureScaleRef = useRef(1);
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

  const applyGestureScale = useCallback((scale: number) => {
    if (!Number.isFinite(scale) || scale <= 0) return;
    setZoom((current) => clampZoom(current * scale));
  }, []);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    const onGestureStart = (event: Event) => {
      event.preventDefault();
      gestureScaleRef.current = 1;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const scale = (event as WebKitGestureEvent).scale ?? 1;
      applyGestureScale(scale / gestureScaleRef.current);
      gestureScaleRef.current = scale;
    };
    const onGestureEnd = (event: Event) => {
      event.preventDefault();
      gestureScaleRef.current = 1;
    };

    wrap.addEventListener("gesturestart", onGestureStart);
    wrap.addEventListener("gesturechange", onGestureChange);
    wrap.addEventListener("gestureend", onGestureEnd);
    return () => {
      wrap.removeEventListener("gesturestart", onGestureStart);
      wrap.removeEventListener("gesturechange", onGestureChange);
      wrap.removeEventListener("gestureend", onGestureEnd);
    };
  }, [applyGestureScale]);

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
        const totalPages = pdf.numPages;
        docRef.current = pdf;
        setNumPages(totalPages);
        setPage((current) => clampPage(current, totalPages));
        setDoc(pdf);
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
    let textLayer: TextLayerRender | null = null;
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
        const pageLayer = pageLayerRef.current;
        const textLayerElement = textLayerRef.current;
        if (!canvas || !pageLayer || !textLayerElement) return;
        pageLayer.style.width = `${viewport.width}px`;
        pageLayer.style.height = `${viewport.height}px`;
        textLayerElement.replaceChildren();
        textLayerElement.style.setProperty("--scale-factor", String(zoom));
        const canvasContext = canvas.getContext("2d");
        if (!canvasContext) return;
        // Render at the device pixel ratio so pages are crisp on HiDPI/Retina
        // displays. The canvas BITMAP is sized in physical pixels (viewport ×
        // dpr) while its CSS box stays in layout pixels (viewport), and the draw
        // is scaled up by `transform`. Without this the canvas is a 1× bitmap the
        // browser stretches to 2× → blurry until you zoom in (which adds real
        // pixels). The text-layer overlay tracks the CSS box, so it stays aligned.
        const outputScale = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const transform =
          outputScale !== 1
            ? [outputScale, 0, 0, outputScale, 0, 0]
            : undefined;
        task = pdfPage.render({ canvasContext, viewport, transform });
        const textContent = await pdfPage.getTextContent();
        if (cancelled) return;
        textLayer = new pdfjsLib.TextLayer({
          container: textLayerElement,
          textContentSource: textContent,
          viewport,
        });
        await Promise.all([task.promise, textLayer.render()]);
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
      textLayer?.cancel();
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

  // Ctrl/Cmd + wheel = zoom. React attaches `onWheel` as a passive listener, so
  // preventDefault() there is a no-op (the page zooms/scrolls instead). Attach a
  // non-passive native listener so the gesture is captured by the viewer.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const handler = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      setZoom((current) => zoomFromWheel(current, event.deltaY));
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

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
        <div ref={pageLayerRef} className="pdf-page-layer">
          <canvas ref={canvasRef} className="pdf-canvas" />
          <div
            ref={textLayerRef}
            className="pdf-text-layer textLayer"
            aria-label="Selectable PDF text"
          />
        </div>
      </div>
    </div>
  );
}
