// Global workbench layout state (Zustand).
//
// This store owns the visibility and sizing of the shell regions: sidebar,
// bottom panel, and the right-side preview panel, plus which activity-bar
// view and which bottom-panel tab is active. It is intentionally UI-only;
// editor/document state lives elsewhere in later milestones.
//
// Layout is persisted across launches (debounced) by lib/settingsPersistence,
// via persistedLayoutData/sanitizeLayoutData below.

import { create } from "zustand";

export type ActivityView =
  | "explorer"
  | "search";

export type BottomTab = "terminal" | "problems" | "output";

/** Where the Terminal/Output/Problems panel docks: along the bottom or the right. */
export type PanelPosition = "bottom" | "right";

// Size clamps (px). Exported so components/resizers and tests share one source.
export const SIDEBAR_MIN_WIDTH = 100;
// Hard sanity ceiling. The real drag limit is dynamic (window width minus the
// activity bar and a minimum editor — see getSidebarMaxWidth in App.tsx), so on
// normal windows the editor-room cap binds first; this only guards absurd
// persisted/edited values on very wide displays.
export const SIDEBAR_MAX_WIDTH = 1600;
// Smallest editor area to keep visible when the sidebar is dragged wide.
export const EDITOR_MIN_WIDTH = 120;
export const BOTTOM_MIN_HEIGHT = 80;
export const BOTTOM_MAX_HEIGHT = 800;
export const PANEL_MIN_WIDTH = 200;
// Hard sanity ceiling. The real drag limit for the right-docked panel is dynamic
// (the full center width, so the editor can be squeezed to nothing — see
// getPanelMaxWidth in App.tsx); this only guards absurd persisted values.
export const PANEL_MAX_WIDTH = 4000;
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
  /** Width of the panel when docked on the right (`panelPosition === "right"`). */
  panelWidth: number;
  /** Whether the bottom panel docks along the bottom or on the right. */
  panelPosition: PanelPosition;
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
  setPanelWidth: (width: number) => void;
  setPanelPosition: (position: PanelPosition) => void;
  /** Flip the panel between bottom and right docking. */
  togglePanelPosition: () => void;
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
  panelWidth: 480,
  panelPosition: "bottom",
  activeBottomTab: "terminal",
  pdfPanelVisible: false,
  pdfPanelWidth: 480,
  editorPreview: false,
};

/**
 * The slice of layout state worth persisting across launches. `editorPreview`
 * is excluded: it's transient, tied to whichever document is active.
 */
export function persistedLayoutData(state: LayoutData): Omit<LayoutData, "editorPreview"> {
  return {
    sidebarVisible: state.sidebarVisible,
    sidebarWidth: state.sidebarWidth,
    activeView: state.activeView,
    bottomPanelVisible: state.bottomPanelVisible,
    bottomPanelHeight: state.bottomPanelHeight,
    panelWidth: state.panelWidth,
    panelPosition: state.panelPosition,
    activeBottomTab: state.activeBottomTab,
    pdfPanelVisible: state.pdfPanelVisible,
    pdfPanelWidth: state.pdfPanelWidth,
  };
}

/**
 * Validate untrusted (on-disk) layout JSON into a partial update: unknown or
 * malformed fields are dropped and sizes re-clamped, so a stale/edited file
 * can never wedge the workbench. Used by layout persistence at startup.
 */
export function sanitizeLayoutData(raw: unknown): Partial<LayoutData> {
  if (typeof raw !== "object" || raw === null) return {};
  const p = raw as Partial<Record<keyof LayoutData, unknown>>;
  const out: Partial<LayoutData> = {};
  if (typeof p.sidebarVisible === "boolean") out.sidebarVisible = p.sidebarVisible;
  if (typeof p.sidebarWidth === "number" && Number.isFinite(p.sidebarWidth)) {
    out.sidebarWidth = clamp(p.sidebarWidth, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
  }
  if (p.activeView === "explorer" || p.activeView === "search") {
    out.activeView = p.activeView;
  }
  if (typeof p.bottomPanelVisible === "boolean") {
    out.bottomPanelVisible = p.bottomPanelVisible;
  }
  if (
    typeof p.bottomPanelHeight === "number" &&
    Number.isFinite(p.bottomPanelHeight)
  ) {
    out.bottomPanelHeight = clamp(
      p.bottomPanelHeight,
      BOTTOM_MIN_HEIGHT,
      BOTTOM_MAX_HEIGHT,
    );
  }
  if (typeof p.panelWidth === "number" && Number.isFinite(p.panelWidth)) {
    out.panelWidth = clamp(p.panelWidth, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH);
  }
  if (p.panelPosition === "bottom" || p.panelPosition === "right") {
    out.panelPosition = p.panelPosition;
  }
  if (
    p.activeBottomTab === "terminal" ||
    p.activeBottomTab === "problems" ||
    p.activeBottomTab === "output"
  ) {
    out.activeBottomTab = p.activeBottomTab;
  }
  if (typeof p.pdfPanelVisible === "boolean") out.pdfPanelVisible = p.pdfPanelVisible;
  if (typeof p.pdfPanelWidth === "number" && Number.isFinite(p.pdfPanelWidth)) {
    out.pdfPanelWidth = clamp(p.pdfPanelWidth, PDF_MIN_WIDTH, PDF_MAX_WIDTH);
  }
  return out;
}

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
  setPanelWidth: (width) =>
    set({ panelWidth: clamp(width, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH) }),
  setPanelPosition: (position) => set({ panelPosition: position }),
  togglePanelPosition: () =>
    set((s) => ({
      panelPosition: s.panelPosition === "bottom" ? "right" : "bottom",
    })),
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
