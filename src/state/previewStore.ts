// Preview panel state (Zustand): the active preview is a PDF, Markdown document,
// or image. PDFs keep a per-path view state (page + zoom) so each document
// remembers where it was last viewed.

import { create } from "zustand";

export interface PdfViewState {
  page: number;
  zoom: number;
}

export interface PreviewData {
  pdfPath: string | null;
  markdownPath: string | null;
  imagePath: string | null;
  viewState: Record<string, PdfViewState>;
}

export interface PreviewActions {
  openPdf: (path: string) => void;
  openMarkdown: (path: string) => void;
  openImage: (path: string) => void;
  closePdf: () => void;
  closePreview: () => void;
  setViewState: (path: string, state: PdfViewState) => void;
}

export type PreviewState = PreviewData & PreviewActions;

export const initialPreviewData: PreviewData = {
  pdfPath: null,
  markdownPath: null,
  imagePath: null,
  viewState: {},
};

// Cap on remembered per-PDF view states. A long session opening many distinct
// PDFs would otherwise accumulate an entry per path for the app's lifetime.
const MAX_VIEW_STATES = 50;

export const usePreviewStore = create<PreviewState>()((set) => ({
  ...initialPreviewData,

  // Opening one kind of preview clears the others.
  openPdf: (path) => set({ pdfPath: path, markdownPath: null, imagePath: null }),
  openMarkdown: (path) =>
    set({ markdownPath: path, pdfPath: null, imagePath: null }),
  openImage: (path) =>
    set({ imagePath: path, pdfPath: null, markdownPath: null }),

  closePdf: () => set({ pdfPath: null }),
  closePreview: () => set({ pdfPath: null, markdownPath: null, imagePath: null }),

  setViewState: (path, state) =>
    set((s) => {
      // Delete-then-set so the just-touched path moves to the most-recent
      // position (object key order is insertion order), giving a simple LRU.
      const next = { ...s.viewState };
      delete next[path];
      next[path] = state;
      const keys = Object.keys(next);
      if (keys.length > MAX_VIEW_STATES) {
        delete next[keys[0]]; // evict the least-recently-touched entry
      }
      return { viewState: next };
    }),
}));
