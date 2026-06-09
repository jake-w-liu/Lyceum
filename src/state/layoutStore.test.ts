import { beforeEach, describe, expect, it } from "vitest";
import {
  BOTTOM_MAX_HEIGHT,
  BOTTOM_MIN_HEIGHT,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  PDF_MAX_WIDTH,
  PDF_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  initialLayoutData,
  useLayoutStore,
} from "./layoutStore";

const reset = () => useLayoutStore.setState(initialLayoutData, false);
const get = () => useLayoutStore.getState();

describe("layoutStore", () => {
  beforeEach(reset);

  it("starts with sane defaults", () => {
    expect(get().sidebarVisible).toBe(true);
    expect(get().activeView).toBe("explorer");
    expect(get().bottomPanelVisible).toBe(false);
    expect(get().pdfPanelVisible).toBe(false);
  });

  it("toggles the sidebar", () => {
    get().toggleSidebar();
    expect(get().sidebarVisible).toBe(false);
    get().toggleSidebar();
    expect(get().sidebarVisible).toBe(true);
  });

  describe("panel position", () => {
    it("defaults to bottom", () => {
      expect(get().panelPosition).toBe("bottom");
    });

    it("toggles between bottom and right", () => {
      get().togglePanelPosition();
      expect(get().panelPosition).toBe("right");
      get().togglePanelPosition();
      expect(get().panelPosition).toBe("bottom");
    });

    it("sets a specific position", () => {
      get().setPanelPosition("right");
      expect(get().panelPosition).toBe("right");
    });

    it("clamps the right-dock width", () => {
      get().setPanelWidth(10_000);
      expect(get().panelWidth).toBe(PANEL_MAX_WIDTH);
      get().setPanelWidth(1);
      expect(get().panelWidth).toBe(PANEL_MIN_WIDTH);
      get().setPanelWidth(500);
      expect(get().panelWidth).toBe(500);
    });
  });

  describe("selectView", () => {
    it("switches to a different view and shows the sidebar", () => {
      get().setSidebarVisible(false);
      get().selectView("search");
      expect(get().activeView).toBe("search");
      expect(get().sidebarVisible).toBe(true);
    });

    it("collapses the sidebar when clicking the already-active view", () => {
      get().selectView("explorer"); // explorer already active + visible
      expect(get().sidebarVisible).toBe(false);
    });

    it("re-opens the sidebar when clicking a view while collapsed", () => {
      get().setSidebarVisible(false);
      get().selectView("explorer");
      expect(get().sidebarVisible).toBe(true);
      expect(get().activeView).toBe("explorer");
    });
  });

  describe("sidebar width clamping", () => {
    it("clamps below the minimum", () => {
      get().setSidebarWidth(10);
      expect(get().sidebarWidth).toBe(SIDEBAR_MIN_WIDTH);
    });
    it("clamps above the maximum", () => {
      get().setSidebarWidth(99999);
      expect(get().sidebarWidth).toBe(SIDEBAR_MAX_WIDTH);
    });
    it("accepts a value within range", () => {
      get().setSidebarWidth(320);
      expect(get().sidebarWidth).toBe(320);
    });
  });

  describe("bottom panel", () => {
    it("toggles visibility", () => {
      get().toggleBottomPanel();
      expect(get().bottomPanelVisible).toBe(true);
      get().toggleBottomPanel();
      expect(get().bottomPanelVisible).toBe(false);
    });

    it("clamps height", () => {
      get().setBottomPanelHeight(1);
      expect(get().bottomPanelHeight).toBe(BOTTOM_MIN_HEIGHT);
      get().setBottomPanelHeight(99999);
      expect(get().bottomPanelHeight).toBe(BOTTOM_MAX_HEIGHT);
    });

    it("changes the active tab", () => {
      get().setActiveBottomTab("problems");
      expect(get().activeBottomTab).toBe("problems");
    });

    it("showBottomTab opens the panel and focuses the tab", () => {
      get().showBottomTab("output");
      expect(get().bottomPanelVisible).toBe(true);
      expect(get().activeBottomTab).toBe("output");
    });
  });

  describe("toggleTerminal", () => {
    it("opens the panel on the terminal tab when hidden", () => {
      get().toggleTerminal();
      expect(get().bottomPanelVisible).toBe(true);
      expect(get().activeBottomTab).toBe("terminal");
    });

    it("closes the panel when terminal tab is already showing", () => {
      get().showBottomTab("terminal");
      get().toggleTerminal();
      expect(get().bottomPanelVisible).toBe(false);
    });

    it("switches to terminal when another tab is showing", () => {
      get().showBottomTab("problems");
      get().toggleTerminal();
      expect(get().bottomPanelVisible).toBe(true);
      expect(get().activeBottomTab).toBe("terminal");
    });
  });

  describe("pdf panel", () => {
    it("toggles visibility", () => {
      get().togglePdfPanel();
      expect(get().pdfPanelVisible).toBe(true);
    });
    it("clamps width", () => {
      get().setPdfPanelWidth(1);
      expect(get().pdfPanelWidth).toBe(PDF_MIN_WIDTH);
      get().setPdfPanelWidth(99999);
      expect(get().pdfPanelWidth).toBe(PDF_MAX_WIDTH);
    });
  });
});
