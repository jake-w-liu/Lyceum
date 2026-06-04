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
});
