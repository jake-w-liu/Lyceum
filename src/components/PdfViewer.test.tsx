import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcMocks = vi.hoisted(() => ({
  readFileBytes: vi.fn(),
}));

const pdfMocks = vi.hoisted(() => ({
  destroy: vi.fn(),
  getDocument: vi.fn(),
  getAnnotations: vi.fn(),
  getDestination: vi.fn(),
  getPage: vi.fn(),
  getPageIndex: vi.fn(),
  getTextContent: vi.fn(),
  getViewport: vi.fn(),
  annotationLayerRender: vi.fn(),
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
  AnnotationLayer: vi.fn().mockImplementation(({ div }) => ({
    render: (params: unknown) => pdfMocks.annotationLayerRender(params, div),
  })),
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
    getAnnotations: pdfMocks.getAnnotations,
    getTextContent: pdfMocks.getTextContent,
    getViewport: pdfMocks.getViewport,
    render: pdfMocks.pageRender,
  };
  pdfMocks.getPage.mockResolvedValue(pageProxy);
  pdfMocks.getDocument.mockReturnValue({
    promise: Promise.resolve({
      annotationStorage: {},
      destroy: pdfMocks.destroy,
      getDestination: pdfMocks.getDestination,
      getPage: pdfMocks.getPage,
      getPageIndex: pdfMocks.getPageIndex,
      numPages,
    }),
  });
}

beforeEach(() => {
  usePreviewStore.setState(initialPreviewData, false);
  Object.values(pdfMocks).forEach((mock) => mock.mockReset());
  ipcMocks.readFileBytes.mockReset();
  ipcMocks.readFileBytes.mockResolvedValue(new Uint8Array([1, 2, 3]));
  pdfMocks.getAnnotations.mockResolvedValue([]);
  pdfMocks.getDestination.mockResolvedValue(null);
  pdfMocks.getPageIndex.mockResolvedValue(0);
  pdfMocks.getTextContent.mockResolvedValue({ items: [], styles: {} });
  pdfMocks.getViewport.mockImplementation(({ scale }: { scale: number }) => {
    const viewport = {
      height: 240 * scale,
      width: 180 * scale,
      clone: vi.fn(
        ({ scale: nextScale }: { scale?: number; dontFlip?: boolean } = {}) =>
          pdfMocks.getViewport({ scale: nextScale ?? scale }),
      ),
      convertToViewportPoint: vi.fn((x: number, y: number) => [
        x * scale,
        (240 - y) * scale,
      ]),
    };
    return viewport;
  });
  pdfMocks.annotationLayerRender.mockImplementation(
    async (_params: unknown, div: HTMLDivElement) => {
      div.replaceChildren();
    },
  );
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
  it("renders every page of a multi-page document in one continuous scroll", async () => {
    mockPdfDocument(3);

    const { container } = render(<PdfViewer path="/w/paper.pdf" />);

    // Indicator shows the total; the top page is current.
    const indicator = await screen.findByLabelText("Page number");
    expect(indicator).toHaveValue("1");
    expect(indicator.parentElement).toHaveTextContent("/ 3");
    // One page-layer per page, stacked in a single scroll container — i.e. a
    // continuous document, not a single paged canvas.
    const scroll = container.querySelector(".pdf-scroll") as HTMLElement;
    expect(scroll.querySelectorAll(".pdf-page-layer")).toHaveLength(3);
    // The visible page actually renders (async).
    await waitFor(() => expect(pdfMocks.getPage).toHaveBeenCalledWith(1));
    expect(usePreviewStore.getState().viewState["/w/paper.pdf"]).toEqual({
      page: 1,
      zoom: 1,
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the restored page instead of deriving current page from the render cache", async () => {
    usePreviewStore
      .getState()
      .setViewState("/w/page-two.pdf", { page: 2, zoom: 1 });
    mockPdfDocument(3);

    render(<PdfViewer path="/w/page-two.pdf" />);

    const indicator = await screen.findByLabelText("Page number");
    expect(indicator).toHaveValue("2");
    expect(indicator.parentElement).toHaveTextContent("/ 3");
    await waitFor(() => expect(pdfMocks.getPage).toHaveBeenCalledWith(2));
    expect(screen.getByLabelText("Page number")).toHaveValue("2");
  });

  it("restores the saved zoom on reopen", async () => {
    usePreviewStore
      .getState()
      .setViewState("/w/zoomed.pdf", { page: 1, zoom: 1.5 });
    mockPdfDocument(2);

    render(<PdfViewer path="/w/zoomed.pdf" />);

    expect(await screen.findByText("150%")).toBeInTheDocument();
    await waitFor(() =>
      expect(pdfMocks.getViewport).toHaveBeenCalledWith({ scale: 1.5 }),
    );
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
      await screen.findByLabelText("Page number");
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

  it("renders PDF annotation links and jumps to internal destinations", async () => {
    const destinationRef = { num: 5, gen: 0 };
    pdfMocks.getAnnotations.mockResolvedValue([{ id: "link-1", dest: "sec" }]);
    pdfMocks.getDestination.mockResolvedValue([
      destinationRef,
      { name: "XYZ" },
      0,
      240,
      null,
    ]);
    pdfMocks.getPageIndex.mockResolvedValue(2);
    pdfMocks.annotationLayerRender.mockImplementation(
      async (
        params: {
          annotations: Array<{ dest?: string }>;
          linkService: {
            getDestinationHash: (dest: string) => string;
            goToDestination: (dest: string) => Promise<void>;
          };
        },
        div: HTMLDivElement,
      ) => {
        div.replaceChildren();
        for (const annotation of params.annotations) {
          if (!annotation.dest) continue;
          const section = document.createElement("section");
          section.className = "linkAnnotation";
          const link = document.createElement("a");
          link.href = params.linkService.getDestinationHash(annotation.dest);
          link.onclick = () => {
            void params.linkService.goToDestination(annotation.dest!);
            return false;
          };
          section.append(link);
          div.append(section);
        }
      },
    );
    mockPdfDocument(3);

    const { container } = render(<PdfViewer path="/w/links.pdf" />);

    expect(await screen.findByLabelText("Page number")).toHaveValue("1");
    await waitFor(() =>
      expect(container.querySelector(".pdf-annotation-layer a")).not.toBeNull(),
    );
    fireEvent.click(container.querySelector(".pdf-annotation-layer a")!);

    await waitFor(() =>
      expect(screen.getByLabelText("Page number")).toHaveValue("3"),
    );
    expect(pdfMocks.getDestination).toHaveBeenCalledWith("sec");
    expect(pdfMocks.getPageIndex).toHaveBeenCalledWith(destinationRef);
  });

  it("finds text and navigates matches via the find bar", async () => {
    pdfMocks.getTextContent.mockResolvedValue({
      items: [{ str: "the quick brown fox the" }],
      styles: {},
    });
    mockPdfDocument(1);

    render(<PdfViewer path="/w/find.pdf" />);
    await screen.findByLabelText("Page number");

    // Opening find reveals the input; "the" matches twice on the page.
    fireEvent.click(screen.getByRole("button", { name: "Find in document" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Find in document" }), {
      target: { value: "the" },
    });
    expect(await screen.findByText("1 of 2")).toBeInTheDocument();

    // Next wraps around; Escape closes the bar.
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(await screen.findByText("2 of 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(await screen.findByText("1 of 2")).toBeInTheDocument();

    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Find in document" }),
      { key: "Escape" },
    );
    expect(
      screen.queryByRole("textbox", { name: "Find in document" }),
    ).not.toBeInTheDocument();
  });

  it("reports no results for a query that is not present", async () => {
    pdfMocks.getTextContent.mockResolvedValue({
      items: [{ str: "lorem ipsum" }],
      styles: {},
    });
    mockPdfDocument(1);

    render(<PdfViewer path="/w/none.pdf" />);
    await screen.findByLabelText("Page number");

    fireEvent.click(screen.getByRole("button", { name: "Find in document" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Find in document" }), {
      target: { value: "zzz" },
    });
    expect(await screen.findByText("No results")).toBeInTheDocument();
  });
});
