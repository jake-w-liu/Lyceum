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

  it("openImage sets the imagePath and clears other preview kinds", () => {
    usePreviewStore.getState().openPdf("/proj/paper.pdf");
    usePreviewStore.getState().openImage("/proj/figure.png");

    expect(usePreviewStore.getState().imagePath).toBe("/proj/figure.png");
    expect(usePreviewStore.getState().pdfPath).toBeNull();
    expect(usePreviewStore.getState().markdownPath).toBeNull();
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

  it("closePreview clears all active preview paths", () => {
    usePreviewStore.getState().openImage("/proj/figure.jpg");
    usePreviewStore.getState().closePreview();

    expect(usePreviewStore.getState().pdfPath).toBeNull();
    expect(usePreviewStore.getState().markdownPath).toBeNull();
    expect(usePreviewStore.getState().imagePath).toBeNull();
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

  it("caps viewState entries (LRU eviction), keeping the most recently touched", () => {
    const set = usePreviewStore.getState().setViewState;
    // Insert well past the cap of 50.
    for (let i = 0; i < 60; i++) set(`/p/${i}.pdf`, { page: 1, zoom: 1 });

    const { viewState } = usePreviewStore.getState();
    const keys = Object.keys(viewState);
    expect(keys.length).toBe(50);
    // The 10 oldest (0..9) were evicted; the newest remain.
    expect(viewState["/p/0.pdf"]).toBeUndefined();
    expect(viewState["/p/9.pdf"]).toBeUndefined();
    expect(viewState["/p/59.pdf"]).toEqual({ page: 1, zoom: 1 });

    // Re-touching an existing key refreshes its recency so it survives eviction.
    set("/p/10.pdf", { page: 2, zoom: 2 });
    set("/p/60.pdf", { page: 1, zoom: 1 }); // forces one eviction (now 51 -> 50)
    const after = usePreviewStore.getState().viewState;
    expect(after["/p/10.pdf"]).toEqual({ page: 2, zoom: 2 }); // survived (recently touched)
    expect(after["/p/11.pdf"]).toBeUndefined(); // evicted as the new oldest
  });
});
