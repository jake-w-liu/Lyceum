// Unit tests for the preview store: openPdf/closePdf path handling (closePdf
// keeps view state) and per-path setViewState that coexists across documents.

import { beforeEach, describe, expect, it } from "vitest";

import { initialPreviewData, usePreviewStore } from "./previewStore";

beforeEach(() => {
  usePreviewStore.setState(initialPreviewData, false);
});

describe("previewStore", () => {
  it("openPdf sets the pdfPath", () => {
    usePreviewStore.getState().openPdf("/proj/paper.pdf");
    expect(usePreviewStore.getState().pdfPath).toBe("/proj/paper.pdf");
  });

  it("closePdf nulls pdfPath but keeps prior viewState", () => {
    usePreviewStore.getState().openPdf("/proj/paper.pdf");
    usePreviewStore
      .getState()
      .setViewState("/proj/paper.pdf", { page: 3, zoom: 1.5 });

    usePreviewStore.getState().closePdf();

    expect(usePreviewStore.getState().pdfPath).toBeNull();
    expect(usePreviewStore.getState().viewState["/proj/paper.pdf"]).toEqual({
      page: 3,
      zoom: 1.5,
    });
  });

  it("setViewState stores per path and entries for other paths coexist", () => {
    usePreviewStore
      .getState()
      .setViewState("/proj/a.pdf", { page: 1, zoom: 1 });
    usePreviewStore
      .getState()
      .setViewState("/proj/b.pdf", { page: 7, zoom: 2 });

    const { viewState } = usePreviewStore.getState();
    expect(viewState["/proj/a.pdf"]).toEqual({ page: 1, zoom: 1 });
    expect(viewState["/proj/b.pdf"]).toEqual({ page: 7, zoom: 2 });
  });
});
