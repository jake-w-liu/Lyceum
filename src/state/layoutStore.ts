// Global workbench layout state (Zustand).
//
// This store owns the visibility and sizing of the shell regions: sidebar,
// bottom panel, and the right-side preview panel, plus which activity-bar
// view and which bottom-panel tab is active. It is intentionally UI-only;
// editor/document state lives elsewhere in later milestones.
//
// Persistence of these values (restore on startup) is a M10 concern; for now
// the store is in-memory with sensible defaults.

import { create } from "zustand";

export type ActivityView =
  | "explorer"
  | "search";

export type BottomTab = "terminal" | "problems" | "output";

// Size clamps (px). Exported so components/resizers and tests share one source.
export const SIDEBAR_MIN_WIDTH = 170;
export const SIDEBAR_MAX_WIDTH = 600;
export const BOTTOM_MIN_HEIGHT = 80;
export const BOTTOM_MAX_HEIGHT = 800;
export const PDF_MIN_WIDTH = 240;
export const PDF_MAX_WIDTH = 1000;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export interface LayoutData {
  sidebarVisible: boolean;
  sidebarWidth: number;
  activeView: ActivityView;
  bottomPanelVisible: boolean;
  bottomPanelHeight: number;
  activeBottomTab: BottomTab;
  pdfPanelVisible: boolean;
  pdfPanelWidth: number;
  /**
   * When true, the editor area renders an inline source preview in place of the
   * source editor (currently Markdown and HTML). It replaces the editor view
   * rather than opening the right-side panel.
   */
  editorPreview: boolean;
}

export interface LayoutActions {
  toggleSidebar: () => void;
  setSidebarVisible: (visible: boolean) => void;
  setSidebarWidth: (width: number) => void;
  setActiveView: (view: ActivityView) => void;
  /**
   * Activity-bar click behavior (VS Code-like): clicking the icon for the view
   * that is already showing collapses the sidebar; clicking any other view
   * shows the sidebar and switches to it.
   */
  selectView: (view: ActivityView) => void;

  toggleBottomPanel: () => void;
  setBottomPanelVisible: (visible: boolean) => void;
  setBottomPanelHeight: (height: number) => void;
  setActiveBottomTab: (tab: BottomTab) => void;
  /** Open the bottom panel and focus a specific tab. */
  showBottomTab: (tab: BottomTab) => void;
  /**
   * Ctrl+` behavior: open the panel on the terminal tab, or close it if the
   * terminal tab is already showing, or switch to terminal if another tab is.
   */
  toggleTerminal: () => void;

  togglePdfPanel: () => void;
  setPdfPanelVisible: (visible: boolean) => void;
  setPdfPanelWidth: (width: number) => void;

  toggleEditorPreview: () => void;
  setEditorPreview: (on: boolean) => void;
}

export type LayoutState = LayoutData & LayoutActions;

export const initialLayoutData: LayoutData = {
  sidebarVisible: true,
  sidebarWidth: 260,
  activeView: "explorer",
  bottomPanelVisible: false,
  bottomPanelHeight: 240,
  activeBottomTab: "terminal",
  pdfPanelVisible: false,
  pdfPanelWidth: 480,
  editorPreview: false,
};

export const useLayoutStore = create<LayoutState>((set) => ({
  ...initialLayoutData,

  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  setSidebarVisible: (visible) => set({ sidebarVisible: visible }),
  setSidebarWidth: (width) =>
    set({ sidebarWidth: clamp(width, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH) }),
  setActiveView: (view) => set({ activeView: view }),
  selectView: (view) =>
    set((s) =>
      s.sidebarVisible && s.activeView === view
        ? { sidebarVisible: false }
        : { sidebarVisible: true, activeView: view },
    ),

  toggleBottomPanel: () =>
    set((s) => ({ bottomPanelVisible: !s.bottomPanelVisible })),
  setBottomPanelVisible: (visible) => set({ bottomPanelVisible: visible }),
  setBottomPanelHeight: (height) =>
    set({
      bottomPanelHeight: clamp(height, BOTTOM_MIN_HEIGHT, BOTTOM_MAX_HEIGHT),
    }),
  setActiveBottomTab: (tab) => set({ activeBottomTab: tab }),
  showBottomTab: (tab) =>
    set({ bottomPanelVisible: true, activeBottomTab: tab }),
  toggleTerminal: () =>
    set((s) => {
      if (!s.bottomPanelVisible) {
        return { bottomPanelVisible: true, activeBottomTab: "terminal" };
      }
      if (s.activeBottomTab === "terminal") {
        return { bottomPanelVisible: false };
      }
      return { activeBottomTab: "terminal" };
    }),

  togglePdfPanel: () => set((s) => ({ pdfPanelVisible: !s.pdfPanelVisible })),
  setPdfPanelVisible: (visible) => set({ pdfPanelVisible: visible }),
  setPdfPanelWidth: (width) =>
    set({ pdfPanelWidth: clamp(width, PDF_MIN_WIDTH, PDF_MAX_WIDTH) }),

  toggleEditorPreview: () => set((s) => ({ editorPreview: !s.editorPreview })),
  setEditorPreview: (on) => set({ editorPreview: on }),
}));
