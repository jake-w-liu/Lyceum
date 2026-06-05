// Lazy PDF.js viewer (M6): renders every page stacked in one continuously
// scrolling column. Each page draws to its own <canvas> with a text overlay,
// but only while it is near the viewport (IntersectionObserver) — pages that
// scroll far away release their bitmap so a large document doesn't hold one
// canvas per page. The toolbar pages/zooms; per-file page+zoom is persisted in
// the preview store so reopening a PDF restores roughly where it was.

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

type PageRefs = React.MutableRefObject<Map<number, HTMLDivElement>>;

// A4-ish fallback so a not-yet-rendered page reserves plausible scroll space;
// replaced by the page's real size the moment it first renders.
const FALLBACK_SIZE = { w: 612, h: 792 };

/**
 * One page in the continuous scroll. Renders its canvas + text layer only when
 * `visible`, releasing both when it scrolls out so memory stays bounded. The
 * outer box keeps its (page-sized) dimensions either way so scroll height and
 * position are stable as pages render and release.
 */
function PdfPage({
  doc,
  pageNumber,
  zoom,
  visible,
  pageRefs,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  zoom: number;
  visible: boolean;
  pageRefs: PageRefs;
}) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef<PDFPageProxy | null>(null);
  // Intrinsic page size (scale 1); drives the placeholder box before render.
  const [size, setSize] = useState(FALLBACK_SIZE);
  const [renderError, setRenderError] = useState<string | null>(null);

  // Register the element so the parent can observe it and scroll to it. Runs
  // before the parent's observer effect (child effects fire first), so the map
  // is populated when the observer starts.
  useEffect(() => {
    const map = pageRefs.current;
    const el = elRef.current;
    if (el) map.set(pageNumber, el);
    return () => {
      map.delete(pageNumber);
    };
  }, [pageNumber, pageRefs]);

  useEffect(() => {
    if (!visible) {
      // Release the rendered bitmap and page resources; keep the box size.
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      textLayerRef.current?.replaceChildren();
      pageRef.current?.cleanup();
      pageRef.current = null;
      return;
    }

    let cancelled = false;
    let task: RenderTask | null = null;
    let textLayer: TextLayerRender | null = null;
    setRenderError(null);
    (async () => {
      try {
        const pdfPage = await doc.getPage(pageNumber);
        if (cancelled) return;
        pageRef.current = pdfPage;
        const viewport = pdfPage.getViewport({ scale: zoom });
        const baseViewport = pdfPage.getViewport({ scale: 1 });
        setSize({ w: baseViewport.width, h: baseViewport.height });

        const canvas = canvasRef.current;
        const textLayerElement = textLayerRef.current;
        if (!canvas || !textLayerElement) return;
        textLayerElement.replaceChildren();
        textLayerElement.style.setProperty("--scale-factor", String(zoom));

        const canvasContext = canvas.getContext("2d");
        if (!canvasContext) return;
        // Render at the device pixel ratio so pages are crisp on HiDPI/Retina
        // displays: the bitmap is sized in physical pixels (viewport × dpr) while
        // its CSS box stays in layout pixels, and the draw is scaled by transform.
        const outputScale = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const transform =
          outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;

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
    return () => {
      cancelled = true;
      task?.cancel();
      textLayer?.cancel();
    };
  }, [visible, doc, pageNumber, zoom]);

  return (
    <div
      ref={elRef}
      data-page={pageNumber}
      className="pdf-page-layer"
      style={{ width: size.w * zoom, height: size.h * zoom }}
    >
      <canvas ref={canvasRef} className="pdf-canvas" />
      <div
        ref={textLayerRef}
        className="pdf-text-layer textLayer"
        aria-label={`Page ${pageNumber} text`}
      />
      {renderError && (
        <div className="pdf-error pdf-error-inline" role="alert">
          Failed to render page {pageNumber}: {renderError}
        </div>
      )}
    </div>
  );
}

export default function PdfViewer({ path }: { path: string }) {
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const gestureScaleRef = useRef(1);
  const restoredRef = useRef(false);

  const saved = usePreviewStore.getState().viewState[path];
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(saved?.page ?? 1);
  const [zoom, setZoom] = useState(saved?.zoom ?? 1);
  const [visiblePages, setVisiblePages] = useState<Set<number>>(new Set());
  // A fatal load error replaces the whole viewer; per-page render errors are
  // shown inline by each PdfPage so the rest of the document stays usable.
  const [loadError, setLoadError] = useState<string | null>(null);

  const scrollToPage = useCallback((target: number) => {
    pageRefs.current.get(target)?.scrollIntoView({ block: "start" });
  }, []);

  const applyGestureScale = useCallback((scale: number) => {
    if (!Number.isFinite(scale) || scale <= 0) return;
    setZoom((current) => clampZoom(current * scale));
  }, []);

  // Trackpad pinch-zoom (Safari/WebKit gesture events) over the scroll area.
  useEffect(() => {
    const wrap = scrollRef.current;
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

  // Ctrl/Cmd + wheel = zoom. React's onWheel is passive, so attach a non-passive
  // native listener to actually preventDefault the browser zoom/scroll.
  useEffect(() => {
    const el = scrollRef.current;
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

  // Load the document.
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
        setNumPages(pdf.numPages);
        setDoc(pdf);
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
      void docRef.current?.destroy();
      docRef.current = null;
    };
  }, [path]);

  // Once the page count is known, seed the restored page (so it renders without
  // waiting for the observer) and scroll to it after the first paint.
  useEffect(() => {
    if (numPages === 0 || restoredRef.current) return;
    restoredRef.current = true;
    const start = clampPage(saved?.page ?? 1, numPages);
    setPage(start);
    setVisiblePages((prev) => new Set(prev).add(start));
    if (start > 1) {
      const schedule =
        typeof requestAnimationFrame === "function"
          ? requestAnimationFrame
          : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0);
      schedule(() => scrollToPage(start));
    }
    // `saved` is read once at mount; intentionally not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numPages, scrollToPage]);

  // Observe which pages are near the viewport so only those render. Without
  // IntersectionObserver (e.g. jsdom) fall back to rendering every page.
  useEffect(() => {
    if (numPages === 0) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisiblePages(
        new Set(Array.from({ length: numPages }, (_, i) => i + 1)),
      );
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        setVisiblePages((prev) => {
          const next = new Set(prev);
          for (const entry of entries) {
            const n = Number((entry.target as HTMLElement).dataset.page);
            if (!n) continue;
            if (entry.isIntersecting) next.add(n);
            else next.delete(n);
          }
          return next;
        });
      },
      // Render a screen ahead/behind so scrolling reveals ready pages.
      { root: scrollRef.current, rootMargin: "400px 0px", threshold: 0.01 },
    );
    for (const el of pageRefs.current.values()) io.observe(el);
    return () => io.disconnect();
  }, [numPages]);

  // The page indicator tracks the topmost page currently in view.
  useEffect(() => {
    if (visiblePages.size === 0) return;
    let top = Infinity;
    for (const n of visiblePages) if (n < top) top = n;
    if (top !== Infinity) setPage(top);
  }, [visiblePages]);

  // Persist current page + zoom for restore-on-reopen.
  useEffect(() => {
    if (numPages === 0) return;
    usePreviewStore.getState().setViewState(path, { page, zoom });
  }, [page, zoom, path, numPages]);

  const fitWidth = async () => {
    const pdf = docRef.current;
    const wrap = scrollRef.current;
    if (!pdf || !wrap) return;
    try {
      const pdfPage = await pdf.getPage(page);
      const base = pdfPage.getViewport({ scale: 1 });
      if (base.width <= 0) return;
      // Account for the scroll container's horizontal padding (12px each side).
      setZoom(clampZoom((wrap.clientWidth - 24) / base.width));
    } catch {
      // ignore; fit-width is best-effort
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
          onClick={() => scrollToPage(clampPage(page - 1, numPages))}
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
          onClick={() => scrollToPage(clampPage(page + 1, numPages))}
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
      <div ref={scrollRef} className="pdf-scroll">
        {doc &&
          Array.from({ length: numPages }, (_, i) => i + 1).map((n) => (
            <PdfPage
              key={n}
              doc={doc}
              pageNumber={n}
              zoom={zoom}
              visible={visiblePages.has(n)}
              pageRefs={pageRefs}
            />
          ))}
      </div>
    </div>
  );
}
