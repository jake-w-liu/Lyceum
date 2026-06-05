import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcMocks = vi.hoisted(() => ({
  readFileBytes: vi.fn(),
}));

const pdfMocks = vi.hoisted(() => ({
  destroy: vi.fn(),
  getDocument: vi.fn(),
  getPage: vi.fn(),
  getTextContent: vi.fn(),
  getViewport: vi.fn(),
  pageCleanup: vi.fn(),
  pageRender: vi.fn(),
  taskCancel: vi.fn(),
  textLayerCancel: vi.fn(),
  textLayerRender: vi.fn(),
}));

vi.mock("../lib/ipc", () => ({
  readFileBytes: (path: string) => ipcMocks.readFileBytes(path),
}));

vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: "pdf-worker-url",
}));

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  getDocument: pdfMocks.getDocument,
  TextLayer: vi.fn().mockImplementation(() => ({
    cancel: pdfMocks.textLayerCancel,
    render: pdfMocks.textLayerRender,
  })),
}));

import PdfViewer from "./PdfViewer";
import { initialPreviewData, usePreviewStore } from "../state/previewStore";

const originalGetContext = HTMLCanvasElement.prototype.getContext;

function mockPdfDocument(numPages: number) {
  const pageProxy = {
    cleanup: pdfMocks.pageCleanup,
    getTextContent: pdfMocks.getTextContent,
    getViewport: pdfMocks.getViewport,
    render: pdfMocks.pageRender,
  };
  pdfMocks.getPage.mockResolvedValue(pageProxy);
  pdfMocks.getDocument.mockReturnValue({
    promise: Promise.resolve({
      destroy: pdfMocks.destroy,
      getPage: pdfMocks.getPage,
      numPages,
    }),
  });
}

beforeEach(() => {
  usePreviewStore.setState(initialPreviewData, false);
  Object.values(pdfMocks).forEach((mock) => mock.mockReset());
  ipcMocks.readFileBytes.mockReset();
  ipcMocks.readFileBytes.mockResolvedValue(new Uint8Array([1, 2, 3]));
  pdfMocks.getTextContent.mockResolvedValue({ items: [], styles: {} });
  pdfMocks.getViewport.mockImplementation(({ scale }: { scale: number }) => ({
    height: 240 * scale,
    width: 180 * scale,
  }));
  pdfMocks.pageRender.mockReturnValue({
    cancel: pdfMocks.taskCancel,
    promise: Promise.resolve(),
  });
  pdfMocks.textLayerRender.mockResolvedValue(undefined);
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: vi.fn(() => ({})),
  });
});

afterEach(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: originalGetContext,
  });
});

describe("PdfViewer", () => {
  it("clamps a restored page to the loaded document's page count", async () => {
    usePreviewStore
      .getState()
      .setViewState("/w/paper.pdf", { page: 9, zoom: 1 });
    mockPdfDocument(2);

    render(<PdfViewer path="/w/paper.pdf" />);

    expect(await screen.findByText("2 / 2")).toBeInTheDocument();
    await waitFor(() => expect(pdfMocks.getPage).toHaveBeenCalledWith(2));
    expect(usePreviewStore.getState().viewState["/w/paper.pdf"]).toEqual({
      page: 2,
      zoom: 1,
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders the canvas at the device pixel ratio for crisp HiDPI output", async () => {
    const originalDpr = Object.getOwnPropertyDescriptor(
      window,
      "devicePixelRatio",
    );
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 2,
    });
    try {
      mockPdfDocument(1);
      const { container } = render(<PdfViewer path="/w/hd.pdf" />);
      await screen.findByText("1 / 1");
      await waitFor(() => expect(pdfMocks.pageRender).toHaveBeenCalled());

      const canvas = container.querySelector(
        "canvas.pdf-canvas",
      ) as HTMLCanvasElement;
      // viewport at zoom 1 is 180×240; the bitmap is scaled by dpr=2 while the
      // CSS box stays at the layout size, and the draw is scaled via transform.
      expect(canvas.width).toBe(360);
      expect(canvas.height).toBe(480);
      expect(canvas.style.width).toBe("180px");
      expect(canvas.style.height).toBe("240px");
      expect(pdfMocks.pageRender.mock.calls[0][0].transform).toEqual([
        2, 0, 0, 2, 0, 0,
      ]);
    } finally {
      if (originalDpr) {
        Object.defineProperty(window, "devicePixelRatio", originalDpr);
      } else {
        delete (window as unknown as Record<string, unknown>).devicePixelRatio;
      }
    }
  });
});
