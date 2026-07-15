// PDF.js lays text out as absolutely positioned spans. Browser selection needs
// a movable, full-layer sentinel to turn pointer coordinates into a stable DOM
// range; without it, a visually continuous drag can select disjoint spans.
// This is the selection-only part of PDF.js's TextLayerBuilder, kept separate
// so PdfViewer can continue using the lower-level, virtualized TextLayer.

// Use PDF.js's selective compatibility ranges without importing its
// browser-only rendering bundle into Node-based tests and release tooling. A
// full-string NFKC pass would be too broad (for example, it changes ① to 1).
const PDF_COMPATIBILITY_GLYPHS =
  /(?:[\u00a0\u00b5\u037e\u0eb3\u2000-\u200a\u202f\u2126\ufb00-\ufb04\ufb06\ufb20-\ufb36\ufb38-\ufb3c\ufb3e\ufb40\ufb41\ufb43\ufb44\ufb46-\ufba1\ufba4-\ufba9\ufbae-\ufbb1\ufbd3-\ufbdc\ufbde-\ufbe7\ufbea-\ufbf8\ufbfc\ufbfd\ufc00-\ufc5d\ufc64-\ufcf1\ufcf5-\ufd3d\ufd88\ufdf4\ufdfa\ufdfb\ufe71\ufe77\ufe79\ufe7b\ufe7d]+|\ufb05+)/gu;

function normalizePdfUnicode(value: string): string {
  return value.replace(PDF_COMPATIBILITY_GLYPHS, (match: string) =>
    match[0] === "ﬅ" ? match.replace(/ﬅ/gu, "ſt") : match.normalize("NFKC"),
  );
}

type TextLayerRegistration = {
  endOfContent: HTMLDivElement;
  onCopy: (event: ClipboardEvent) => void;
  onMouseDown: () => void;
};

const textLayers = new Map<HTMLDivElement, TextLayerRegistration>();

let selectionListeners: AbortController | null = null;
let previousRange: Range | null = null;
let firefoxSelection: boolean | null = null;

function resetTextLayer(
  textLayer: HTMLDivElement,
  endOfContent: HTMLDivElement,
): void {
  textLayer.append(endOfContent);
  endOfContent.style.width = "";
  endOfContent.style.height = "";
  textLayer.classList.remove("selecting");
}

function selectionIntersectsLayer(
  range: Range,
  textLayer: HTMLDivElement,
): boolean {
  // A selectionchange may race with virtualized page removal. A detached layer
  // cannot be part of the live selection and some engines throw for that case.
  if (!textLayer.isConnected) return false;
  try {
    return range.intersectsNode(textLayer);
  } catch {
    return false;
  }
}

function removeSelectionListenersIfUnused(): void {
  if (textLayers.size !== 0) return;
  selectionListeners?.abort();
  selectionListeners = null;
  previousRange = null;
  firefoxSelection = null;
}

function ensureSelectionListeners(): void {
  if (selectionListeners) return;

  selectionListeners = new AbortController();
  const { signal } = selectionListeners;
  let pointerDown = false;

  const resetAll = (): void => {
    for (const [textLayer, { endOfContent }] of textLayers) {
      resetTextLayer(textLayer, endOfContent);
    }
  };

  document.addEventListener(
    "pointerdown",
    () => {
      pointerDown = true;
    },
    { signal },
  );
  document.addEventListener(
    "pointerup",
    () => {
      pointerDown = false;
      resetAll();
    },
    { signal },
  );
  window.addEventListener(
    "blur",
    () => {
      pointerDown = false;
      resetAll();
    },
    { signal },
  );
  document.addEventListener(
    "keyup",
    () => {
      if (!pointerDown) resetAll();
    },
    { signal },
  );
  document.addEventListener(
    "selectionchange",
    () => {
      const selection = document.getSelection();
      if (!selection || selection.rangeCount === 0) {
        resetAll();
        previousRange = null;
        return;
      }

      const activeTextLayers = new Set<HTMLDivElement>();
      for (let index = 0; index < selection.rangeCount; index += 1) {
        const range = selection.getRangeAt(index);
        for (const textLayer of textLayers.keys()) {
          if (
            !activeTextLayers.has(textLayer) &&
            selectionIntersectsLayer(range, textLayer)
          ) {
            activeTextLayers.add(textLayer);
          }
        }
      }

      for (const [textLayer, { endOfContent }] of textLayers) {
        if (activeTextLayers.has(textLayer)) {
          textLayer.classList.add("selecting");
        } else {
          resetTextLayer(textLayer, endOfContent);
        }
      }

      // Firefox handles absolutely positioned ranges without the movable
      // sentinel; moving it there can interfere with the native selection.
      const firstRegistration = textLayers.values().next().value as
        | TextLayerRegistration
        | undefined;
      if (!firstRegistration) return;
      firefoxSelection ??=
        getComputedStyle(firstRegistration.endOfContent).getPropertyValue(
          "-moz-user-select",
        ) === "none";
      if (firefoxSelection) return;

      const range = selection.getRangeAt(0);
      const modifyStart =
        previousRange !== null &&
        (range.compareBoundaryPoints(Range.END_TO_END, previousRange) === 0 ||
          range.compareBoundaryPoints(Range.START_TO_END, previousRange) === 0);
      let anchor: Node | null = modifyStart
        ? range.startContainer
        : range.endContainer;
      if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
      if (!(anchor instanceof Element)) return;

      // Match PDF.js exactly here: relocate the sentinel only when the moving
      // boundary belongs to a child inside the text layer. WebKit sometimes
      // reports the text-layer element itself as the boundary while dragging
      // through blank space. Inserting the sentinel into that same Range
      // container changes its child offsets and corrupts the live selection.
      const anchorParent = anchor.parentElement;
      const parentTextLayer = anchorParent?.closest(
        ".pdf-text-layer",
      ) as HTMLDivElement | null;
      const registration = parentTextLayer
        ? textLayers.get(parentTextLayer)
        : undefined;
      if (registration && anchorParent && parentTextLayer) {
        const { endOfContent } = registration;
        endOfContent.style.width = parentTextLayer.style.width;
        endOfContent.style.height = parentTextLayer.style.height;
        anchorParent.insertBefore(
          endOfContent,
          modifyStart ? anchor : anchor.nextSibling,
        );
      }
      previousRange = range.cloneRange();
    },
    { signal },
  );
}

/**
 * Adds PDF.js-compatible selection geometry to a fully rendered text layer.
 * Returns an idempotent cleanup function for page virtualization/unmounting.
 */
export function registerPdfTextSelection(textLayer: HTMLDivElement): () => void {
  const existing = textLayers.get(textLayer);
  if (existing) {
    textLayer.removeEventListener("copy", existing.onCopy);
    textLayer.removeEventListener("mousedown", existing.onMouseDown);
    existing.endOfContent.remove();
    textLayers.delete(textLayer);
  }

  const endOfContent = document.createElement("div");
  endOfContent.className = "endOfContent";
  textLayer.append(endOfContent);

  const onMouseDown = (): void => {
    textLayer.classList.add("selecting");
  };
  const onCopy = (event: ClipboardEvent): void => {
    const selection = document.getSelection();
    if (!selection || !event.clipboardData) return;
    // Match PDF.js's TextLayerBuilder: PDF text can contain compatibility
    // glyphs and embedded NULs that should not reach the clipboard unchanged.
    const copiedText = normalizePdfUnicode(selection.toString()).replace(
      /\0/g,
      "",
    );
    event.clipboardData.setData("text/plain", copiedText);
    event.preventDefault();
    event.stopPropagation();
  };
  textLayer.addEventListener("mousedown", onMouseDown);
  textLayer.addEventListener("copy", onCopy);
  const registration = { endOfContent, onCopy, onMouseDown };
  textLayers.set(textLayer, registration);
  ensureSelectionListeners();

  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    if (textLayers.get(textLayer) !== registration) return;
    textLayer.removeEventListener("copy", onCopy);
    textLayer.removeEventListener("mousedown", onMouseDown);
    textLayer.classList.remove("selecting");
    endOfContent.remove();
    textLayers.delete(textLayer);
    removeSelectionListenersIfUnused();
  };
}
