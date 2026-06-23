import { ActivityBar } from "./components/ActivityBar";
import { Sidebar } from "./components/Sidebar";
import { EditorArea } from "./components/EditorArea";
import { BottomPanel } from "./components/BottomPanel";
import { PdfPanel } from "./components/PdfPanel";
import { StatusBar } from "./components/StatusBar";
import { Resizer } from "./components/Resizer";
import { CommandPalette } from "./components/CommandPalette";
import { QuickOpen } from "./components/QuickOpen";
import { ContextMenu } from "./components/ContextMenu";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useCommandKeybindings } from "./hooks/useCommandKeybindings";
import { useMenuCommands } from "./hooks/useMenuCommands";
import { useOpenFileBridge } from "./hooks/useOpenFileBridge";
import { useWorkspaceFileWatcher } from "./hooks/useWorkspaceFileWatcher";
import { useWorkspaceLifecycle } from "./hooks/useWorkspaceLifecycle";
import {
  BOTTOM_MAX_HEIGHT,
  BOTTOM_MIN_HEIGHT,
  EDITOR_MIN_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useLayoutStore,
} from "./state/layoutStore";
import { applyThemeAttribute, useThemeStore } from "./state/themeStore";
import {
  initSettingsPersistence,
  loadKeybindings,
  loadSettings,
  openLaunchDir,
  restoreWorkspace,
} from "./lib/settingsPersistence";
import { initZoom } from "./lib/zoom";
import "./commands/builtinCommands";

function getElementHeight(el: Element | null): number {
  if (!(el instanceof HTMLElement)) return 0;
  return el.getBoundingClientRect().height || el.offsetHeight;
}

function getElementWidth(el: Element | null): number {
  if (!(el instanceof HTMLElement)) return 0;
  return el.getBoundingClientRect().width || el.offsetWidth;
}

// Widest the sidebar may be dragged: the window minus the activity bar (measured
// so it tracks CSS) and a minimum editor area, capped by the hard ceiling. Falls
// back gracefully before first paint when widths read as 0.
function getSidebarMaxWidth(): number {
  const activityBarWidth = getElementWidth(
    document.querySelector(".activity-bar"),
  );
  const available = window.innerWidth - activityBarWidth - EDITOR_MIN_WIDTH;
  return Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(SIDEBAR_MAX_WIDTH, available),
  );
}

// Widest the right-docked panel may be dragged: the full center minus the
// resizer, so the editor can be squeezed to nothing (the user explicitly wants
// to drop the editor and run the terminal full-width). Falls back to the store
// value before first paint when the center width reads as 0.
function getPanelMaxWidth(center: HTMLDivElement | null): number {
  const centerWidth = getElementWidth(center);
  if (centerWidth <= 0) return PANEL_MAX_WIDTH;
  // The .resizer-vertical has negative margins (net ~0 footprint), so the panel
  // can take the full center and squeeze the editor to nothing.
  return Math.max(PANEL_MIN_WIDTH, centerWidth);
}

function getBottomPanelMaxHeight(center: HTMLDivElement | null): number {
  const centerHeight = getElementHeight(center);
  if (centerHeight <= 0) return BOTTOM_MAX_HEIGHT;

  const tabBarHeight = getElementHeight(
    center?.querySelector(".editor-area > .tab-bar") ?? null,
  );
  if (tabBarHeight <= 0) return BOTTOM_MAX_HEIGHT;

  return Math.max(
    BOTTOM_MIN_HEIGHT,
    Math.min(BOTTOM_MAX_HEIGHT, centerHeight - tabBarHeight),
  );
}

export default function App() {
  useCommandKeybindings();
  useMenuCommands();
  useOpenFileBridge();
  useWorkspaceLifecycle();
  useWorkspaceFileWatcher();

  const centerRef = useRef<HTMLDivElement>(null);
  const theme = useThemeStore((s) => s.theme);
  useEffect(() => applyThemeAttribute(theme), [theme]);

  // Load persisted settings + restore the last workspace once on startup.
  useEffect(() => {
    void (async () => {
      await loadSettings();
      await loadKeybindings();
      // Apply the persisted window zoom and keep it synced to the setting.
      initZoom();
      await restoreWorkspace();
      initSettingsPersistence();
      // A launch-dir (`lyceum /path`) overrides the restored workspace; runs
      // after persistence init so the opened folder is remembered next time.
      await openLaunchDir();
    })();
  }, []);

  const sidebarVisible = useLayoutStore((s) => s.sidebarVisible);
  const bottomPanelVisible = useLayoutStore((s) => s.bottomPanelVisible);
  const panelPosition = useLayoutStore((s) => s.panelPosition);
  const pdfPanelVisible = useLayoutStore((s) => s.pdfPanelVisible);
  const getBottomPanelResizeMax = useCallback(
    () => getBottomPanelMaxHeight(centerRef.current),
    [],
  );

  useLayoutEffect(() => {
    if (!bottomPanelVisible || panelPosition !== "bottom") return;

    const clampBottomPanelHeight = () => {
      const { bottomPanelHeight, setBottomPanelHeight } =
        useLayoutStore.getState();
      const maxHeight = getBottomPanelResizeMax();
      if (bottomPanelHeight > maxHeight) {
        setBottomPanelHeight(maxHeight);
      }
    };

    clampBottomPanelHeight();
    window.addEventListener("resize", clampBottomPanelHeight);
    return () => window.removeEventListener("resize", clampBottomPanelHeight);
  }, [bottomPanelVisible, getBottomPanelResizeMax, panelPosition]);

  // Shrinking the window must not let an already-wide sidebar bury the editor.
  useLayoutEffect(() => {
    if (!sidebarVisible) return;

    const clampSidebarWidth = () => {
      const { sidebarWidth, setSidebarWidth } = useLayoutStore.getState();
      const maxWidth = getSidebarMaxWidth();
      if (sidebarWidth > maxWidth) setSidebarWidth(maxWidth);
    };

    clampSidebarWidth();
    window.addEventListener("resize", clampSidebarWidth);
    return () => window.removeEventListener("resize", clampSidebarWidth);
  }, [sidebarVisible]);

  // Keep the right-docked panel within the center when the window shrinks.
  useLayoutEffect(() => {
    if (!bottomPanelVisible || panelPosition !== "right") return;

    const clampPanelWidth = () => {
      const { panelWidth, setPanelWidth } = useLayoutStore.getState();
      const maxWidth = getPanelMaxWidth(centerRef.current);
      if (panelWidth > maxWidth) setPanelWidth(maxWidth);
    };

    clampPanelWidth();
    window.addEventListener("resize", clampPanelWidth);
    return () => window.removeEventListener("resize", clampPanelWidth);
  }, [bottomPanelVisible, panelPosition]);

  return (
    <div className="app">
      <div className="workbench">
        <ActivityBar />

        {sidebarVisible && (
          <>
            <Sidebar />
            <Resizer
              orientation="vertical"
              ariaLabel="Resize sidebar"
              onDelta={(dx) => {
                const { sidebarWidth, setSidebarWidth } =
                  useLayoutStore.getState();
                setSidebarWidth(
                  Math.min(sidebarWidth + dx, getSidebarMaxWidth()),
                );
              }}
            />
          </>
        )}

        {/* The panel stays a child of `.center` in BOTH dock positions, so
            toggling bottom↔right never remounts BottomPanel (and never kills a
            running terminal). Only `.center`'s flex-direction and the resizer
            orientation change. */}
        <div
          className={"center" + (panelPosition === "right" ? " panel-right" : "")}
          ref={centerRef}
        >
          <EditorArea />

          {bottomPanelVisible &&
            (panelPosition === "right" ? (
              <Resizer
                orientation="vertical"
                ariaLabel="Resize panel"
                onDelta={(dx) => {
                  const { panelWidth, setPanelWidth } = useLayoutStore.getState();
                  // The resizer sits on the panel's left edge; dragging left
                  // (dx < 0) widens it.
                  setPanelWidth(
                    Math.min(
                      panelWidth - dx,
                      getPanelMaxWidth(centerRef.current),
                    ),
                  );
                }}
              />
            ) : (
              <Resizer
                orientation="horizontal"
                ariaLabel="Resize panel"
                onDelta={(_dx, dy) => {
                  const { bottomPanelHeight, setBottomPanelHeight } =
                    useLayoutStore.getState();
                  // Dragging up (dy < 0) makes the panel taller.
                  setBottomPanelHeight(
                    Math.min(
                      bottomPanelHeight - dy,
                      getBottomPanelResizeMax(),
                    ),
                  );
                }}
              />
            ))}
          <BottomPanel visible={bottomPanelVisible} />
        </div>

        {pdfPanelVisible && (
          <>
            <Resizer
              orientation="vertical"
              ariaLabel="Resize preview"
              onDelta={(dx) => {
                const { pdfPanelWidth, setPdfPanelWidth } =
                  useLayoutStore.getState();
                // Dragging left (dx < 0) makes the panel wider.
                setPdfPanelWidth(pdfPanelWidth - dx);
              }}
            />
            <PdfPanel />
          </>
        )}
      </div>

      <StatusBar />

      <CommandPalette />
      <QuickOpen />
      <ContextMenu />
    </div>
  );
}
