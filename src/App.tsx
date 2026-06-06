import { ActivityBar } from "./components/ActivityBar";
import { Sidebar } from "./components/Sidebar";
import { EditorArea } from "./components/EditorArea";
import { BottomPanel } from "./components/BottomPanel";
import { PdfPanel } from "./components/PdfPanel";
import { StatusBar } from "./components/StatusBar";
import { Resizer } from "./components/Resizer";
import { CommandPalette } from "./components/CommandPalette";
import { QuickOpen } from "./components/QuickOpen";
import { useEffect } from "react";
import { useCommandKeybindings } from "./hooks/useCommandKeybindings";
import { useMenuCommands } from "./hooks/useMenuCommands";
import { useOpenFileBridge } from "./hooks/useOpenFileBridge";
import { useWorkspaceFileWatcher } from "./hooks/useWorkspaceFileWatcher";
import { useLayoutStore } from "./state/layoutStore";
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

export default function App() {
  useCommandKeybindings();
  useMenuCommands();
  useOpenFileBridge();
  useWorkspaceFileWatcher();

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
  const pdfPanelVisible = useLayoutStore((s) => s.pdfPanelVisible);

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
                setSidebarWidth(sidebarWidth + dx);
              }}
            />
          </>
        )}

        <div className="center">
          <EditorArea />

          {bottomPanelVisible && (
            <>
              <Resizer
                orientation="horizontal"
                ariaLabel="Resize panel"
                onDelta={(_dx, dy) => {
                  const { bottomPanelHeight, setBottomPanelHeight } =
                    useLayoutStore.getState();
                  // Dragging up (dy < 0) makes the panel taller.
                  setBottomPanelHeight(bottomPanelHeight - dy);
                }}
              />
              <BottomPanel />
            </>
          )}
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
    </div>
  );
}
