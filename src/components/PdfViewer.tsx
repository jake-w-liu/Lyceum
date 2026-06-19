// Lazy PDF.js viewer (M6): renders every page stacked in one continuously
// scrolling column. Each page draws to its own <canvas> with a text overlay,
// but only while it is near the viewport (IntersectionObserver) — pages that
// scroll far away release their bitmap so a large document doesn't hold one
// canvas per page. The toolbar pages/zooms; per-file page+zoom is persisted in
// the preview store so reopening a PDF restores roughly where it was.

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  PDFDocumentProxy,
  PDFPageProxy,
  RefProxy,
  RenderTask,
} from "pdfjs-dist/types/src/display/api";
import type { IPDFLinkService } from "pdfjs-dist/types/web/interfaces";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import { readFileBytes } from "../lib/ipc";
import { usePreviewStore } from "../state/previewStore";
import { Icon } from "./Icon";
import {
  capOutputScale,
  clampPage,
  clampZoom,
  zoomFromWheel,
  zoomIn,
  zoomOut,
} from "../lib/pdf";
import {
  buildPageIndex,
  findMatches,
  matchRectsInElement,
  MAX_PDF_MATCHES,
  type PdfMatch,
  type PdfPageIndex,
} from "../lib/pdfSearch";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

type TextLayerRender = {
  cancel: () => void;
  render: () => Promise<unknown>;
};

type WebKitGestureEvent = Event & {
  scale?: number;
};

type PdfDestArray = unknown[];

type PdfDestCommand = {
  name?: string;
};

type PageRefs = MutableRefObject<Map<number, HTMLDivElement>>;

/** A search match to paint on a page: its ordinal among that page's matches
 *  (used to re-locate it in the text layer) plus whether it's the active one. */
type PageHighlight = { occurrence: number; active: boolean };

// A4-ish fallback so a not-yet-rendered page reserves plausible scroll space;
// replaced by the page's real size the moment it first renders.
const FALLBACK_SIZE = { w: 612, h: 792 };

const DEFAULT_SCROLL_PADDING = 12;

type ViewportAnchor = {
  pageNumber: number;
  ratioY: number;
  ratioX: number;
};

type PdfLinkHandlers = {
  getPdf: () => PDFDocumentProxy | null;
  getPage: () => number;
  getPagesCount: () => number;
  scrollToPage: (pageNumber: number) => void;
  scrollToDestination: (
    pageNumber: number,
    destArray: PdfDestArray | null,
  ) => void;
};

function scheduleFrame(cb: FrameRequestCallback): number {
  if (typeof requestAnimationFrame === "function") {
    return requestAnimationFrame(cb);
  }
  return window.setTimeout(() => cb(performance.now()), 0);
}

function cancelFrame(id: number): void {
  if (typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(id);
    return;
  }
  window.clearTimeout(id);
}

function parseCssPixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function scrollPadding(el: HTMLElement): { top: number; left: number } {
  const style = window.getComputedStyle?.(el);
  if (!style) return { top: DEFAULT_SCROLL_PADDING, left: DEFAULT_SCROLL_PADDING };
  return {
    top: parseCssPixels(style.paddingTop) || DEFAULT_SCROLL_PADDING,
    left: parseCssPixels(style.paddingLeft) || DEFAULT_SCROLL_PADDING,
  };
}

function pageOffset(
  wrap: HTMLElement,
  pageEl: HTMLElement,
): { top: number; left: number; width: number; height: number } {
  const wrapRect = wrap.getBoundingClientRect();
  const pageRect = pageEl.getBoundingClientRect();
  return {
    top: pageRect.top - wrapRect.top + wrap.scrollTop,
    left: pageRect.left - wrapRect.left + wrap.scrollLeft,
    width: pageRect.width || pageEl.offsetWidth,
    height: pageRect.height || pageEl.offsetHeight,
  };
}

function captureViewportAnchor(
  wrap: HTMLElement,
  pageRefs: PageRefs,
  numPages: number,
): ViewportAnchor | null {
  if (numPages < 1) return null;
  const padding = scrollPadding(wrap);
  const viewportY = wrap.scrollTop + padding.top;
  const viewportX = wrap.scrollLeft + padding.left;
  let fallback: ViewportAnchor | null = null;
  let fallbackDistance = Infinity;

  for (let n = 1; n <= numPages; n += 1) {
    const pageEl = pageRefs.current.get(n);
    if (!pageEl) continue;
    const offset = pageOffset(wrap, pageEl);
    const height = Math.max(1, offset.height);
    const width = Math.max(1, offset.width);
    const bottom = offset.top + height;
    const right = offset.left + width;
    const ratioY = Math.min(1, Math.max(0, (viewportY - offset.top) / height));
    const ratioX = Math.min(1, Math.max(0, (viewportX - offset.left) / width));

    const distance = Math.abs(viewportY - offset.top);
    if (distance < fallbackDistance) {
      fallbackDistance = distance;
      fallback = { pageNumber: n, ratioY: 0, ratioX: 0 };
    }
    if (viewportY >= offset.top && viewportY < bottom) {
      return {
        pageNumber: n,
        ratioY,
        ratioX: viewportX >= offset.left && viewportX < right ? ratioX : 0,
      };
    }
  }

  return fallback
    ? { pageNumber: fallback.pageNumber, ratioY: 0, ratioX: 0 }
    : null;
}

function destinationCommand(destArray: PdfDestArray | null): string | null {
  const command = destArray?.[1] as PdfDestCommand | undefined;
  return typeof command?.name === "string" ? command.name : null;
}

function destinationNumber(destArray: PdfDestArray, index: number): number | null {
  const value = destArray[index];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isPdfRefProxy(value: unknown): value is RefProxy {
  return (
    typeof value === "object" &&
    value !== null &&
    Number.isInteger((value as Partial<RefProxy>).num) &&
    Number.isInteger((value as Partial<RefProxy>).gen)
  );
}

async function openExternalHref(href: string): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(href);
  } catch {
    // In browser-only tests/dev, preventing app-shell navigation is enough.
  }
}

class LocalPdfLinkService implements IPDFLinkService {
  externalLinkEnabled = true;
  eventBus = null;

  constructor(private handlers: MutableRefObject<PdfLinkHandlers>) {}

  get pagesCount(): number {
    return this.handlers.current.getPagesCount();
  }

  get page(): number {
    return this.handlers.current.getPage();
  }

  set page(value: number) {
    this.goToPage(value);
  }

  get rotation(): number {
    return 0;
  }

  set rotation(_value: number) {
    // Rotation is not exposed by Lyceum's compact PDF toolbar yet.
  }

  get isInPresentationMode(): boolean {
    return false;
  }

  async goToDestination(dest: string | PdfDestArray): Promise<void> {
    const pdf = this.handlers.current.getPdf();
    if (!pdf) return;
    const explicitDest =
      typeof dest === "string" ? await pdf.getDestination(dest) : await dest;
    if (!Array.isArray(explicitDest)) return;

    const pageNumber = await this.pageNumberFromDestination(pdf, explicitDest);
    if (!pageNumber) return;
    this.handlers.current.scrollToDestination(pageNumber, explicitDest);
  }

  goToPage(val: number | string): void {
    const pageNumber = typeof val === "number" ? val : Number.parseInt(val, 10);
    if (!Number.isInteger(pageNumber)) return;
    if (pageNumber < 1 || pageNumber > this.pagesCount) return;
    this.handlers.current.scrollToPage(pageNumber);
  }

  addLinkAttributes(
    link: HTMLAnchorElement,
    url: string,
    newWindow = false,
  ): void {
    if (!url || typeof url !== "string") return;
    if (!this.externalLinkEnabled) {
      link.href = "";
      link.title = `Disabled: ${url}`;
      link.onclick = () => false;
      return;
    }
    link.href = url;
    link.title = url;
    link.target = newWindow ? "_blank" : "_blank";
    link.rel = "noopener noreferrer nofollow";
    link.addEventListener("click", (event) => {
      event.preventDefault();
      void openExternalHref(url);
    });
  }

  getDestinationHash(dest: unknown): string {
    if (typeof dest === "string" && dest.length > 0) {
      return this.getAnchorUrl(`#${encodeURIComponent(dest)}`);
    }
    return this.getAnchorUrl("");
  }

  getAnchorUrl(hash: unknown): string {
    return typeof hash === "string" ? hash : "";
  }

  setHash(hash: string): void {
    const pageMatch = /(?:^|&)page=(\d+)/.exec(hash.replace(/^#/, ""));
    if (pageMatch) this.goToPage(Number.parseInt(pageMatch[1], 10));
  }

  executeNamedAction(action: string): void {
    switch (action) {
      case "FirstPage":
        this.goToPage(1);
        break;
      case "LastPage":
        this.goToPage(this.pagesCount);
        break;
      case "NextPage":
        this.goToPage(this.page + 1);
        break;
      case "PrevPage":
        this.goToPage(this.page - 1);
        break;
      default:
        break;
    }
  }

  async executeSetOCGState(_action: object): Promise<void> {
    // Optional-content-group actions are ignored in the compact viewer.
  }

  private async pageNumberFromDestination(
    pdf: PDFDocumentProxy,
    destArray: PdfDestArray,
  ): Promise<number | null> {
    const destRef = destArray[0];
    let pageNumber: number | null = null;
    if (isPdfRefProxy(destRef)) {
      try {
        pageNumber = (await pdf.getPageIndex(destRef)) + 1;
      } catch {
        pageNumber = null;
      }
    } else if (Number.isInteger(destRef)) {
      pageNumber = (destRef as number) + 1;
    }
    if (!pageNumber || pageNumber < 1 || pageNumber > this.pagesCount) {
      return null;
    }
    return pageNumber;
  }
}

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
  linkService,
  searchQuery,
  highlights,
  onResized,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  zoom: number;
  visible: boolean;
  pageRefs: PageRefs;
  linkService: LocalPdfLinkService;
  searchQuery: string;
  highlights: PageHighlight[] | undefined;
  /** Called when this page's measured box size changes (i.e. it rendered to its
   *  real intrinsic size). Lets the parent re-pin a pending jump once the pages
   *  above the target settle, so the target lands at the viewport top. */
  onResized?: (pageNumber: number) => void;
}) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const annotationLayerRef = useRef<HTMLDivElement | null>(null);
  const highlightLayerRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef<PDFPageProxy | null>(null);
  // Intrinsic page size (scale 1); drives the placeholder box before render.
  const [size, setSize] = useState(FALLBACK_SIZE);
  const [renderError, setRenderError] = useState<string | null>(null);
  // True once this page's text layer is in the DOM, so search highlights can be
  // measured against it. Reset whenever the page re-renders or is released.
  const [textReady, setTextReady] = useState(false);

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

  // Notify the parent when the measured box size changes — i.e. when a real
  // render replaces the placeholder size. The parent uses this to re-pin a
  // pending far-jump once the pages above the target report their real heights.
  useEffect(() => {
    onResized?.(pageNumber);
  }, [size, pageNumber, onResized]);

  useEffect(() => {
    if (!visible) {
      // Release the rendered bitmap and page resources; keep the box size.
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      textLayerRef.current?.replaceChildren();
      annotationLayerRef.current?.replaceChildren();
      highlightLayerRef.current?.replaceChildren();
      pageRef.current?.cleanup();
      pageRef.current = null;
      setTextReady(false);
      // Drop any stale render error so a released (off-screen) page doesn't keep
      // a "Failed to render page N" overlay that flashes when it scrolls back.
      setRenderError(null);
      return;
    }

    let cancelled = false;
    let task: RenderTask | null = null;
    let textLayer: TextLayerRender | null = null;
    setRenderError(null);
    setTextReady(false);
    (async () => {
      try {
        const pdfPage = await doc.getPage(pageNumber);
        if (cancelled) return;
        pageRef.current = pdfPage;
        const viewport = pdfPage.getViewport({ scale: zoom });
        const baseViewport = pdfPage.getViewport({ scale: 1 });
        // Only update when the intrinsic size actually changed: an equal-valued
        // setState still creates a new object and would fire onResized (the parent
        // re-pin), spuriously yanking the scroll on a release+re-render.
        setSize((prev) =>
          prev.w === baseViewport.width && prev.h === baseViewport.height
            ? prev
            : { w: baseViewport.width, h: baseViewport.height },
        );

        const canvas = canvasRef.current;
        const textLayerElement = textLayerRef.current;
        const annotationLayerElement = annotationLayerRef.current;
        if (!canvas || !textLayerElement || !annotationLayerElement) return;
        textLayerElement.replaceChildren();
        annotationLayerElement.replaceChildren();
        textLayerElement.style.setProperty("--scale-factor", String(zoom));
        annotationLayerElement.style.setProperty("--scale-factor", String(zoom));

        const canvasContext = canvas.getContext("2d");
        if (!canvasContext) return;
        // Render at the device pixel ratio so pages are crisp on HiDPI/Retina
        // displays: the bitmap is sized in physical pixels (viewport × dpr) while
        // its CSS box stays in layout pixels, and the draw is scaled by transform.
        // The scale is capped (pdf.js-style maxCanvasPixels) so huge pages at
        // high zoom can't allocate a canvas WebKit refuses to paint; the CSS box
        // still reflects the requested zoom, so the page just renders softer.
        const outputScale = capOutputScale(
          viewport.width,
          viewport.height,
          window.devicePixelRatio || 1,
        );
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
        const annotations = await pdfPage.getAnnotations({ intent: "display" });
        if (cancelled) return;
        const annotationViewport = viewport.clone({ dontFlip: true });
        const annotationLayer = new pdfjsLib.AnnotationLayer({
          div: annotationLayerElement,
          accessibilityManager: null,
          annotationCanvasMap: null,
          annotationEditorUIManager: null,
          page: pdfPage,
          viewport: annotationViewport,
          structTreeLayer: null,
        });
        await Promise.all([
          task.promise,
          textLayer.render(),
          annotationLayer.render({
            annotations,
            viewport: annotationViewport,
            div: annotationLayerElement,
            page: pdfPage,
            linkService,
            annotationStorage: doc.annotationStorage,
            renderForms: true,
            enableScripting: false,
          }),
        ]);
        if (!cancelled) setTextReady(true);
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
  }, [visible, doc, pageNumber, zoom, linkService]);

  // Paint search highlights over the rendered text. Rects are measured from the
  // live text layer, so this re-runs when the page renders (`textReady`), when
  // the matches change, or on zoom (which re-lays-out the text and changes the
  // page box origin). Positions are relative to the page box, hence scroll-safe.
  useEffect(() => {
    const layer = highlightLayerRef.current;
    if (!layer) return;
    layer.replaceChildren();
    const textEl = textLayerRef.current;
    const pageEl = elRef.current;
    if (!textReady || !textEl || !pageEl || !searchQuery || !highlights?.length) {
      return;
    }
    const pageRect = pageEl.getBoundingClientRect();
    let activeBox: HTMLDivElement | null = null;
    for (const h of highlights) {
      for (const rect of matchRectsInElement(textEl, searchQuery, h.occurrence)) {
        const box = document.createElement("div");
        box.className =
          "pdf-search-highlight" +
          (h.active ? " pdf-search-highlight--active" : "");
        box.style.left = `${rect.left - pageRect.left}px`;
        box.style.top = `${rect.top - pageRect.top}px`;
        box.style.width = `${rect.width}px`;
        box.style.height = `${rect.height}px`;
        layer.appendChild(box);
        if (h.active && !activeBox) activeBox = box;
      }
    }
    // Nudge the active match into view. `nearest` is a no-op when it's already
    // visible, so navigating within one screenful doesn't jolt the scroll.
    activeBox?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [textReady, searchQuery, highlights, zoom]);

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
      <div
        ref={annotationLayerRef}
        className="pdf-annotation-layer annotationLayer"
        aria-label={`Page ${pageNumber} annotations`}
      />
      <div
        ref={highlightLayerRef}
        className="pdf-highlight-layer"
        aria-hidden="true"
      />
      {renderError && (
        <div className="pdf-error pdf-error-inline" role="alert">
          Failed to render page {pageNumber}: {renderError}
        </div>
      )}
    </div>
  );
}

// Editable current-page indicator: shows "N / total", and on Enter/blur jumps to
// the typed page. Follows the live `page` as the user scrolls (resets the draft).
function PdfPageInput({
  page,
  numPages,
  onGo,
}: {
  page: number;
  numPages: number;
  onGo: (n: number) => void;
}) {
  const [draft, setDraft] = useState(String(page));
  // Escape must cancel, but blur() still fires onBlur → commit, which would
  // read the stale draft and navigate. The ref marks that blur as a cancel.
  const cancelledRef = useRef(false);
  useEffect(() => {
    setDraft(String(page));
  }, [page]);
  const commit = () => {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    const n = Number.parseInt(draft, 10);
    if (Number.isFinite(n)) {
      // Reconcile the draft to the clamped target HERE rather than relying on the
      // `[page]` effect: when the typed value clamps to the page already shown,
      // navigation is a no-op so `page` never changes and the effect never fires,
      // leaving the input showing the stale out-of-range draft (e.g. "999 / 3").
      const target = Math.min(Math.max(n, 1), Math.max(numPages, 1));
      setDraft(String(target));
      onGo(target);
    } else {
      setDraft(String(page));
    }
  };
  return (
    <span className="pdf-page-indicator">
      <input
        className="pdf-page-input"
        aria-label="Page number"
        inputMode="numeric"
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ""))}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") {
            cancelledRef.current = true;
            setDraft(String(page));
            e.currentTarget.blur();
          }
        }}
      />
      {` / ${numPages}`}
    </span>
  );
}

export default function PdfViewer({ path }: { path: string }) {
  const saved = usePreviewStore.getState().viewState[path];
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const gestureScaleRef = useRef(1);
  const restoredRef = useRef(false);
  const pendingAnchorRef = useRef<ViewportAnchor | null>(null);
  const pendingDestinationRef = useRef<{
    pageNumber: number;
    destArray: PdfDestArray | null;
  } | null>(null);
  // Target page of an in-progress programmatic jump. While set, page-size
  // changes above/at the target re-pin the scroll so the target stays at the
  // viewport top as not-yet-rendered pages settle from placeholder to real size.
  const pendingScrollRef = useRef<number | null>(null);
  const pageStateRef = useRef(saved?.page ?? 1);

  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(saved?.page ?? 1);
  const [zoom, setZoom] = useState(saved?.zoom ?? 1);
  const [visiblePages, setVisiblePages] = useState<Set<number>>(new Set());
  // A fatal load error replaces the whole viewer; per-page render errors are
  // shown inline by each PdfPage so the rest of the document stays usable.
  const [loadError, setLoadError] = useState<string | null>(null);

  // Find-in-document state. The text index is built lazily on first search and
  // cached per-document; matches/activeMatch drive the count, navigation, and
  // per-page highlights.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [matches, setMatches] = useState<PdfMatch[]>([]);
  const [activeMatch, setActiveMatch] = useState(-1);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const findTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const indexRef = useRef<{ doc: PDFDocumentProxy; index: PdfPageIndex[] } | null>(
    null,
  );
  const searchQuery = findQuery.trim();

  useEffect(() => {
    pageStateRef.current = page;
  }, [page]);

  // Mirror visiblePages into a ref so the active-match scroll effect can read the
  // latest visibility WITHOUT depending on it (which would re-run that effect on
  // every scroll and re-snap the view).
  const visiblePagesRef = useRef(visiblePages);
  useEffect(() => {
    visiblePagesRef.current = visiblePages;
  }, [visiblePages]);

  const scrollToPage = useCallback(
    (target: number) => {
      const pageNumber = clampPage(target, numPages);
      const wrap = scrollRef.current;
      const pageEl = pageRefs.current.get(pageNumber);
      setVisiblePages((prev) => new Set(prev).add(pageNumber));
      setPage(pageNumber);
      if (!wrap || !pageEl) return;
      const padding = scrollPadding(wrap);
      const offset = pageOffset(wrap, pageEl);
      wrap.scrollTop = Math.max(0, offset.top - padding.top);
      wrap.scrollLeft = Math.max(0, offset.left - padding.left);
      // Pages above the target may still be placeholder-sized; record the target
      // so handlePageResized re-pins once those pages render to their real size.
      pendingScrollRef.current = pageNumber;
    },
    [numPages],
  );

  // Re-pin a pending far-jump: when a page at or above the target reports a new
  // (real) size, the target's top may have shifted, so re-scroll it to the
  // viewport top. Clear the pending jump once the target itself has rendered, so
  // later resizes (e.g. the user scrolling up) never yank the view back.
  const handlePageResized = useCallback((resizedPage: number) => {
    const target = pendingScrollRef.current;
    if (target === null || resizedPage > target) return;
    const wrap = scrollRef.current;
    const pageEl = pageRefs.current.get(target);
    if (wrap && pageEl) {
      const padding = scrollPadding(wrap);
      const offset = pageOffset(wrap, pageEl);
      wrap.scrollTop = Math.max(0, offset.top - padding.top);
      wrap.scrollLeft = Math.max(0, offset.left - padding.left);
    }
    if (resizedPage === target) pendingScrollRef.current = null;
  }, []);

  const updateCurrentPageFromScroll = useCallback(() => {
    const wrap = scrollRef.current;
    if (!wrap || numPages === 0) return;
    const padding = scrollPadding(wrap);
    const wrapRect = wrap.getBoundingClientRect();
    const wrapHeight = wrapRect.height || wrap.clientHeight;
    if (wrapHeight <= 0) return;
    const viewportTop = wrapRect.top + padding.top;
    const viewportBottom = wrapRect.bottom;
    let nearestPage = 1;
    let nearestDistance = Infinity;

    for (let n = 1; n <= numPages; n += 1) {
      const pageEl = pageRefs.current.get(n);
      if (!pageEl) continue;
      const rect = pageEl.getBoundingClientRect();
      const distance = Math.abs(rect.top - viewportTop);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestPage = n;
      }
      if (rect.bottom > viewportTop && rect.top < viewportBottom) {
        setPage(n);
        return;
      }
    }
    setPage(nearestPage);
  }, [numPages]);

  const setZoomPreservingAnchor = useCallback(
    (nextZoom: (current: number) => number) => {
      const wrap = scrollRef.current;
      pendingAnchorRef.current =
        wrap && numPages > 0
          ? captureViewportAnchor(wrap, pageRefs, numPages)
          : null;
      setZoom((current) => {
        const next = clampZoom(nextZoom(current));
        if (next === current) pendingAnchorRef.current = null;
        return next;
      });
    },
    [numPages],
  );

  const destinationZoom = useCallback(
    (pageNumber: number, destArray: PdfDestArray | null): number | null => {
      const wrap = scrollRef.current;
      const pageEl = pageRefs.current.get(pageNumber);
      if (!wrap || !pageEl || !destArray) return null;
      const command = destinationCommand(destArray);
      const padding = scrollPadding(wrap);
      const baseWidth = Math.max(1, pageEl.offsetWidth / zoom);
      const baseHeight = Math.max(1, pageEl.offsetHeight / zoom);
      const availableWidth = Math.max(1, wrap.clientWidth - padding.left * 2);
      const availableHeight = Math.max(1, wrap.clientHeight - padding.top * 2);

      switch (command) {
        case "XYZ": {
          const scale = destinationNumber(destArray, 4);
          return scale && scale > 0 ? clampZoom(scale) : null;
        }
        case "Fit":
        case "FitB":
          return clampZoom(
            Math.min(availableWidth / baseWidth, availableHeight / baseHeight),
          );
        case "FitH":
        case "FitBH":
          return clampZoom(availableWidth / baseWidth);
        case "FitV":
        case "FitBV":
          return clampZoom(availableHeight / baseHeight);
        case "FitR": {
          const x1 = destinationNumber(destArray, 2);
          const y1 = destinationNumber(destArray, 3);
          const x2 = destinationNumber(destArray, 4);
          const y2 = destinationNumber(destArray, 5);
          if (x1 === null || y1 === null || x2 === null || y2 === null) {
            return null;
          }
          const rectWidth = Math.max(1, Math.abs(x2 - x1));
          const rectHeight = Math.max(1, Math.abs(y2 - y1));
          return clampZoom(
            Math.min(availableWidth / rectWidth, availableHeight / rectHeight),
          );
        }
        default:
          return null;
      }
    },
    [zoom],
  );

  const performDestinationScroll = useCallback(
    async (pageNumber: number, destArray: PdfDestArray | null) => {
      const wrap = scrollRef.current;
      const pageEl = pageRefs.current.get(pageNumber);
      const pdf = docRef.current;
      if (!wrap || !pageEl) return;

      let left = 0;
      let top = 0;
      const command = destinationCommand(destArray);
      if (pdf && destArray && command) {
        try {
          const pdfPage = await pdf.getPage(pageNumber);
          const viewport = pdfPage.getViewport({ scale: zoom });
          const baseViewport = pdfPage.getViewport({ scale: 1 });
          switch (command) {
            case "XYZ": {
              const x = destinationNumber(destArray, 2) ?? 0;
              const y = destinationNumber(destArray, 3) ?? baseViewport.height;
              [left, top] = viewport.convertToViewportPoint(x, y);
              break;
            }
            case "FitH":
            case "FitBH": {
              const y = destinationNumber(destArray, 2) ?? baseViewport.height;
              [, top] = viewport.convertToViewportPoint(0, y);
              break;
            }
            case "FitV":
            case "FitBV": {
              const x = destinationNumber(destArray, 2) ?? 0;
              [left] = viewport.convertToViewportPoint(x, baseViewport.height);
              break;
            }
            case "FitR": {
              const x = destinationNumber(destArray, 2) ?? 0;
              const y = destinationNumber(destArray, 3) ?? baseViewport.height;
              const x2 = destinationNumber(destArray, 4) ?? x;
              const y2 = destinationNumber(destArray, 5) ?? y;
              const a = viewport.convertToViewportPoint(x, y);
              const b = viewport.convertToViewportPoint(x2, y2);
              left = Math.min(a[0], b[0]);
              top = Math.min(a[1], b[1]);
              break;
            }
            case "Fit":
            case "FitB":
            default:
              break;
          }
        } catch {
          // Destination coordinates are best-effort; page-level jump still works.
        }
      }

      const padding = scrollPadding(wrap);
      const offset = pageOffset(wrap, pageEl);
      wrap.scrollTop = Math.max(0, offset.top + top - padding.top);
      wrap.scrollLeft = Math.max(0, offset.left + left - padding.left);
      setPage(pageNumber);
    },
    [zoom],
  );

  const scrollToDestination = useCallback(
    (target: number, destArray: PdfDestArray | null) => {
      const pageNumber = clampPage(target, numPages);
      setVisiblePages((prev) => new Set(prev).add(pageNumber));
      setPage(pageNumber);
      const nextZoom = destinationZoom(pageNumber, destArray);
      if (nextZoom !== null && nextZoom !== zoom) {
        pendingDestinationRef.current = { pageNumber, destArray };
        setZoom(nextZoom);
        return;
      }
      void performDestinationScroll(pageNumber, destArray);
    },
    [destinationZoom, numPages, performDestinationScroll, zoom],
  );

  const linkHandlersRef = useRef<PdfLinkHandlers>({
    getPdf: () => null,
    getPage: () => 1,
    getPagesCount: () => 0,
    scrollToPage: () => {},
    scrollToDestination: () => {},
  });
  linkHandlersRef.current = {
    getPdf: () => docRef.current,
    getPage: () => pageStateRef.current,
    getPagesCount: () => numPages,
    scrollToPage,
    scrollToDestination,
  };
  const linkServiceRef = useRef<LocalPdfLinkService | null>(null);
  if (!linkServiceRef.current) {
    linkServiceRef.current = new LocalPdfLinkService(linkHandlersRef);
  }
  const linkService = linkServiceRef.current;

  const applyGestureScale = useCallback((scale: number) => {
    if (!Number.isFinite(scale) || scale <= 0) return;
    setZoomPreservingAnchor((current) => current * scale);
  }, [setZoomPreservingAnchor]);

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
      setZoomPreservingAnchor((current) => zoomFromWheel(current, event.deltaY));
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [setZoomPreservingAnchor]);

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
    let frame = 0;
    if (start > 1) {
      frame = scheduleFrame(() => scrollToPage(start));
    }
    return () => {
      if (frame) cancelFrame(frame);
    };
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

  // The page indicator tracks the topmost page actually in the viewport. Keep
  // this separate from lazy-render visibility, whose rootMargin intentionally
  // includes pages that are not yet current.
  useEffect(() => {
    const wrap = scrollRef.current;
    if (!wrap || numPages === 0) return;
    let frame = 0;
    const scheduleUpdate = () => {
      if (frame) return;
      frame = scheduleFrame(() => {
        frame = 0;
        updateCurrentPageFromScroll();
      });
    };
    // A user gesture cancels any in-progress jump re-pin, so handlePageResized
    // can never yank the view away from where the user just scrolled. These fire
    // only on real input, never on programmatic scrollTop writes.
    const cancelPendingScroll = () => {
      pendingScrollRef.current = null;
    };
    wrap.addEventListener("scroll", scheduleUpdate, { passive: true });
    wrap.addEventListener("wheel", cancelPendingScroll, { passive: true });
    wrap.addEventListener("pointerdown", cancelPendingScroll, { passive: true });
    scheduleUpdate();
    return () => {
      wrap.removeEventListener("scroll", scheduleUpdate);
      wrap.removeEventListener("wheel", cancelPendingScroll);
      wrap.removeEventListener("pointerdown", cancelPendingScroll);
      if (frame) cancelFrame(frame);
    };
  }, [numPages, updateCurrentPageFromScroll]);

  useLayoutEffect(() => {
    const wrap = scrollRef.current;
    const anchor = pendingAnchorRef.current;
    if (!wrap || !anchor) return;
    pendingAnchorRef.current = null;
    const pageEl = pageRefs.current.get(anchor.pageNumber);
    if (!pageEl) return;
    const padding = scrollPadding(wrap);
    const offset = pageOffset(wrap, pageEl);
    wrap.scrollTop = Math.max(
      0,
      offset.top + offset.height * anchor.ratioY - padding.top,
    );
    wrap.scrollLeft = Math.max(
      0,
      offset.left + offset.width * anchor.ratioX - padding.left,
    );
    updateCurrentPageFromScroll();
  }, [zoom, updateCurrentPageFromScroll]);

  useLayoutEffect(() => {
    const pending = pendingDestinationRef.current;
    if (!pending) return;
    pendingDestinationRef.current = null;
    void performDestinationScroll(pending.pageNumber, pending.destArray);
  }, [zoom, performDestinationScroll]);

  // Persist current page + zoom for restore-on-reopen.
  useEffect(() => {
    if (numPages === 0) return;
    usePreviewStore.getState().setViewState(path, { page, zoom });
  }, [page, zoom, path, numPages]);

  // Build (once per document) a lowercased text index of every page. pdf.js
  // caches page proxies and their text content, so re-opening find is cheap.
  const ensureIndex = useCallback(async (): Promise<PdfPageIndex[]> => {
    const pdf = docRef.current;
    if (!pdf) return [];
    if (indexRef.current?.doc === pdf) return indexRef.current.index;
    const index: PdfPageIndex[] = [];
    for (let n = 1; n <= pdf.numPages; n += 1) {
      try {
        const pdfPage = await pdf.getPage(n);
        const content = await pdfPage.getTextContent();
        index.push(buildPageIndex(n, content));
      } catch {
        index.push(buildPageIndex(n, { items: [] }));
      }
    }
    // The document may have been swapped/destroyed while we awaited.
    if (docRef.current !== pdf) return [];
    indexRef.current = { doc: pdf, index };
    return index;
  }, []);

  // Debounced search whenever the query changes while the find bar is open.
  useEffect(() => {
    if (!findOpen) return;
    if (findTimerRef.current) clearTimeout(findTimerRef.current);
    if (!searchQuery) {
      setMatches([]);
      setActiveMatch(-1);
      return;
    }
    let cancelled = false;
    findTimerRef.current = setTimeout(() => {
      void (async () => {
        const index = await ensureIndex();
        if (cancelled) return;
        const found = findMatches(index, searchQuery);
        setMatches(found);
        // Start at the first match at or after the current page so navigation
        // feels anchored to where the reader already is.
        const current = pageStateRef.current;
        const initial = found.findIndex((m) => m.pageNumber >= current);
        setActiveMatch(found.length ? (initial === -1 ? 0 : initial) : -1);
      })();
    }, 150);
    return () => {
      cancelled = true;
      if (findTimerRef.current) clearTimeout(findTimerRef.current);
    };
    // `doc` re-runs the search against a freshly opened document's index.
  }, [searchQuery, findOpen, ensureIndex, doc]);

  // Clear stale results immediately when the document swaps (the search effect
  // above then re-runs against the new index if find is still open).
  useEffect(() => {
    setMatches([]);
    setActiveMatch(-1);
  }, [doc]);

  // Jump to the active match's page as it changes — but only when that page is
  // not already visible. When several matches share one visible page, forcing
  // scrollToPage would snap to the page top on every Next/Prev before the
  // highlight layer's scrollIntoView nudges the match back, a visible jolt. If
  // the page is already on screen, the per-page highlight scrollIntoView alone
  // brings the specific match into view without resetting scroll.
  useEffect(() => {
    if (activeMatch < 0 || activeMatch >= matches.length) return;
    const target = matches[activeMatch].pageNumber;
    if (!visiblePagesRef.current.has(target)) scrollToPage(target);
  }, [activeMatch, matches, scrollToPage]);

  // Focus the input each time the find bar opens.
  useEffect(() => {
    if (findOpen) findInputRef.current?.select();
  }, [findOpen]);

  // Group matches by page (with per-page ordinals) so each PdfPage can re-locate
  // and highlight them, marking the active one.
  const highlightsByPage = useMemo(() => {
    const byPage = new Map<number, PageHighlight[]>();
    matches.forEach((m, i) => {
      const list = byPage.get(m.pageNumber) ?? [];
      list.push({ occurrence: m.occurrence, active: i === activeMatch });
      byPage.set(m.pageNumber, list);
    });
    return byPage;
  }, [matches, activeMatch]);

  const goToMatch = useCallback(
    (step: number) => {
      setActiveMatch((i) => {
        if (matches.length === 0) return -1;
        const base = i < 0 ? 0 : i;
        return (base + step + matches.length) % matches.length;
      });
    },
    [matches.length],
  );

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setMatches([]);
    setActiveMatch(-1);
    // Drop the full-document text index; it's rebuilt lazily on the next
    // search. (pdf.js keeps managing its own page-proxy caches.)
    indexRef.current = null;
  }, []);

  // Cmd/Ctrl+F opens find when focus is anywhere inside the viewer.
  const handleRootKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // A keyboard SCROLL in the document view (PageUp/Down, arrows, Home/End,
    // space) cancels a pending far-jump re-pin so keyboard scrolling isn't yanked
    // back to the target (wheel/pointerdown already cancel it). Gate on actual
    // scroll keys AND a non-text-entry origin so typing in the find box or the
    // page-number input does NOT cancel an in-flight jump-to-match / restore.
    const target = event.target as HTMLElement;
    const isTextEntry =
      target.tagName === "INPUT" || target.tagName === "TEXTAREA";
    const isScrollKey =
      event.key === "ArrowUp" ||
      event.key === "ArrowDown" ||
      event.key === "PageUp" ||
      event.key === "PageDown" ||
      event.key === "Home" ||
      event.key === "End" ||
      event.key === " ";
    if (isScrollKey && !isTextEntry) {
      pendingScrollRef.current = null;
    }
    if ((event.metaKey || event.ctrlKey) && (event.key === "f" || event.key === "F")) {
      event.preventDefault();
      setFindOpen(true);
      findInputRef.current?.select();
    }
  };

  const fitWidth = async () => {
    const pdf = docRef.current;
    const wrap = scrollRef.current;
    if (!pdf || !wrap) return;
    try {
      const pdfPage = await pdf.getPage(page);
      const base = pdfPage.getViewport({ scale: 1 });
      if (base.width <= 0) return;
      const padding = scrollPadding(wrap);
      setZoomPreservingAnchor(
        () => (wrap.clientWidth - padding.left * 2) / base.width,
      );
    } catch {
      // ignore; fit-width is best-effort
    }
  };

  const fitPage = async () => {
    const pdf = docRef.current;
    const wrap = scrollRef.current;
    if (!pdf || !wrap) return;
    try {
      const pdfPage = await pdf.getPage(page);
      const base = pdfPage.getViewport({ scale: 1 });
      if (base.width <= 0 || base.height <= 0) return;
      const padding = scrollPadding(wrap);
      setZoomPreservingAnchor(() =>
        Math.min(
          (wrap.clientWidth - padding.left * 2) / base.width,
          (wrap.clientHeight - padding.top * 2) / base.height,
        ),
      );
    } catch {
      // ignore; fit-page is best-effort
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
    <div
      className="pdf-viewer"
      ref={rootRef}
      tabIndex={0}
      onKeyDown={handleRootKeyDown}
    >
      <div className="pdf-toolbar">
        <button
          type="button"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => scrollToPage(clampPage(page - 1, numPages))}
        >
          Prev
        </button>
        <PdfPageInput
          page={page}
          numPages={numPages}
          onGo={(n) => scrollToPage(clampPage(n, numPages))}
        />
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
          onClick={() => setZoomPreservingAnchor(zoomOut)}
        >
          -
        </button>
        <span className="pdf-zoom-indicator">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          aria-label="Zoom in"
          onClick={() => setZoomPreservingAnchor(zoomIn)}
        >
          +
        </button>
        <button type="button" aria-label="Fit width" onClick={fitWidth}>
          Fit width
        </button>
        <button type="button" aria-label="Fit page" onClick={fitPage}>
          Fit page
        </button>
        <button
          type="button"
          className={"pdf-find-toggle" + (findOpen ? " active" : "")}
          aria-label="Find in document"
          aria-pressed={findOpen}
          title="Find in document"
          onClick={() => (findOpen ? closeFind() : setFindOpen(true))}
        >
          <Icon name="search" />
        </button>
      </div>
      {findOpen && (
        <div className="pdf-find" role="search">
          <input
            ref={findInputRef}
            className="pdf-find-input"
            type="text"
            aria-label="Find in document"
            placeholder="Find"
            value={findQuery}
            onChange={(e) => setFindQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                goToMatch(e.shiftKey ? -1 : 1);
              } else if (e.key === "Escape") {
                e.preventDefault();
                closeFind();
              }
            }}
          />
          <span className="pdf-find-count" aria-live="polite">
            {matches.length > 0
              ? `${activeMatch + 1} of ${matches.length}` +
                (matches.length >= MAX_PDF_MATCHES ? "+" : "")
              : searchQuery
                ? "No results"
                : ""}
          </span>
          <button
            type="button"
            aria-label="Previous match"
            disabled={matches.length === 0}
            onClick={() => goToMatch(-1)}
          >
            <Icon name="chevron-up" />
          </button>
          <button
            type="button"
            aria-label="Next match"
            disabled={matches.length === 0}
            onClick={() => goToMatch(1)}
          >
            <Icon name="chevron-down" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Close find"
            onClick={closeFind}
          >
            <Icon name="close" />
          </button>
        </div>
      )}
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
              linkService={linkService}
              searchQuery={searchQuery}
              highlights={highlightsByPage.get(n)}
              onResized={handlePageResized}
            />
          ))}
      </div>
    </div>
  );
}
