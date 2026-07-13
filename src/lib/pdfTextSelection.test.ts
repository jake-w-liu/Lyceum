import { afterEach, describe, expect, it, vi } from "vitest";

import {
  correctPdfTextLayerMinimumFontSize,
  registerPdfTextSelection,
} from "./pdfTextSelection";

function makeTextLayer(): {
  layer: HTMLDivElement;
  spans: HTMLSpanElement[];
} {
  const layer = document.createElement("div");
  layer.className = "pdf-text-layer textLayer";
  layer.style.width = "600px";
  layer.style.height = "800px";
  const spans = ["first", "second", "third"].map((text) => {
    const span = document.createElement("span");
    span.textContent = text;
    layer.append(span);
    return span;
  });
  document.body.append(layer);
  return { layer, spans };
}

function selectBetween(start: Node, end: Node): void {
  const selection = document.getSelection();
  if (!selection) throw new Error("Selection API is unavailable in this test");
  const range = document.createRange();
  range.setStart(start, 0);
  range.setEnd(end, end.textContent?.length ?? 0);
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

describe("correctPdfTextLayerMinimumFontSize", () => {
  it("adds PDF.js's missing inverse scale for sub-pixel WebKit probes", () => {
    const layer = document.createElement("div");
    const span = document.createElement("span");
    span.setAttribute("role", "presentation");
    span.style.fontSize = "7.47px";
    span.style.transform = "scaleX(0.98)";
    layer.append(span);

    correctPdfTextLayerMinimumFontSize(layer, 5 / 6);
    correctPdfTextLayerMinimumFontSize(layer, 5 / 6);

    expect(span.style.transform).toBe("scaleX(0.98) scale(1.2)");
    expect(span.dataset.lyceumMinFontCorrected).toBe("true");
  });

  it.each([0, 1, 1.25, Number.NaN])(
    "does not alter spans for a minimum font size of %s",
    (minimumFontSize) => {
      const layer = document.createElement("div");
      const span = document.createElement("span");
      span.setAttribute("role", "presentation");
      span.style.fontSize = "9px";
      span.style.transform = "scaleX(0.9)";
      layer.append(span);

      correctPdfTextLayerMinimumFontSize(layer, minimumFontSize);

      expect(span.style.transform).toBe("scaleX(0.9)");
      expect(span.dataset.lyceumMinFontCorrected).toBeUndefined();
    },
  );
});

describe("PDF text selection geometry", () => {
  it("moves a full-layer sentinel beside the active selection edge", () => {
    const { layer, spans } = makeTextLayer();
    const unregister = registerPdfTextSelection(layer);
    const endOfContent = layer.querySelector(
      ".endOfContent",
    ) as HTMLDivElement;

    try {
      selectBetween(spans[0].firstChild!, spans[1].firstChild!);

      expect(layer).toHaveClass("selecting");
      expect(Array.from(layer.children)).toEqual([
        spans[0],
        spans[1],
        endOfContent,
        spans[2],
      ]);
      expect(endOfContent.style.width).toBe("600px");
      expect(endOfContent.style.height).toBe("800px");
    } finally {
      unregister();
    }
  });

  it("does not mutate a WebKit range whose boundary is the text layer", () => {
    const { layer, spans } = makeTextLayer();
    const unregister = registerPdfTextSelection(layer);
    const endOfContent = layer.querySelector(
      ".endOfContent",
    ) as HTMLDivElement;

    try {
      const selection = document.getSelection()!;
      const range = document.createRange();
      range.setStart(spans[0].firstChild!, 0);
      range.setEnd(layer, 2);
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));

      expect(Array.from(layer.children)).toEqual([
        spans[0],
        spans[1],
        spans[2],
        endOfContent,
      ]);
      expect(range.endContainer).toBe(layer);
      expect(range.endOffset).toBe(2);
      expect(endOfContent.style.width).toBe("");
      expect(endOfContent.style.height).toBe("");
    } finally {
      unregister();
    }
  });

  it("restores the sentinel and selection state when the drag ends", () => {
    const { layer, spans } = makeTextLayer();
    const unregister = registerPdfTextSelection(layer);
    const endOfContent = layer.querySelector(
      ".endOfContent",
    ) as HTMLDivElement;

    try {
      layer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      selectBetween(spans[0].firstChild!, spans[1].firstChild!);
      document.dispatchEvent(new Event("pointerup"));

      expect(layer).not.toHaveClass("selecting");
      expect(layer.lastElementChild).toBe(endOfContent);
      expect(endOfContent.style.width).toBe("");
      expect(endOfContent.style.height).toBe("");
    } finally {
      unregister();
    }
  });

  it("leaves sentinel relocation to Firefox's native selection handling", () => {
    const { layer, spans } = makeTextLayer();
    const unregister = registerPdfTextSelection(layer);
    const endOfContent = layer.querySelector(
      ".endOfContent",
    ) as HTMLDivElement;
    const getComputedStyleSpy = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation(
        (element) =>
          ({
            getPropertyValue: (property: string) =>
              element === endOfContent && property === "-moz-user-select"
                ? "none"
                : "",
          }) as CSSStyleDeclaration,
      );

    try {
      selectBetween(spans[0].firstChild!, spans[1].firstChild!);

      expect(getComputedStyleSpy).toHaveBeenCalledWith(endOfContent);
      expect(layer).toHaveClass("selecting");
      expect(layer.lastElementChild).toBe(endOfContent);
      expect(endOfContent.style.width).toBe("");
      expect(endOfContent.style.height).toBe("");
    } finally {
      unregister();
      getComputedStyleSpy.mockRestore();
    }
  });

  it("unregisters idempotently when a virtualized page is released", () => {
    const { layer } = makeTextLayer();
    const abortSpy = vi.spyOn(AbortController.prototype, "abort");
    const unregister = registerPdfTextSelection(layer);

    try {
      unregister();
      unregister();

      expect(layer.querySelector(".endOfContent")).toBeNull();
      layer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      expect(layer).not.toHaveClass("selecting");
      expect(abortSpy).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
      abortSpy.mockRestore();
    }
  });

  it("keeps shared selection listeners until the final page is released", () => {
    const first = makeTextLayer();
    const second = makeTextLayer();
    const abortSpy = vi.spyOn(AbortController.prototype, "abort");
    const unregisterFirst = registerPdfTextSelection(first.layer);
    const unregisterSecond = registerPdfTextSelection(second.layer);

    try {
      unregisterFirst();
      expect(abortSpy).not.toHaveBeenCalled();

      second.layer.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      );
      expect(second.layer).toHaveClass("selecting");

      unregisterSecond();
      expect(abortSpy).toHaveBeenCalledTimes(1);
    } finally {
      unregisterFirst();
      unregisterSecond();
      abortSpy.mockRestore();
    }
  });

  it("copies normalized PDF text without embedded NUL characters", () => {
    const { layer, spans } = makeTextLayer();
    spans[0].textContent = "oﬃce\0 ①";
    const unregister = registerPdfTextSelection(layer);
    const setData = vi.fn();
    const copyEvent = new Event("copy", {
      bubbles: true,
      cancelable: true,
    }) as ClipboardEvent;
    Object.defineProperty(copyEvent, "clipboardData", {
      value: { setData },
    });

    try {
      selectBetween(spans[0].firstChild!, spans[0].firstChild!);
      layer.dispatchEvent(copyEvent);

      expect(setData).toHaveBeenCalledWith("text/plain", "office ①");
      expect(copyEvent.defaultPrevented).toBe(true);
    } finally {
      unregister();
    }
  });
});
