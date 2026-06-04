// Built-in command registrations (M4). Importing this module registers every
// workbench action as a command (id -> run). Keybindings and the command
// palette dispatch these ids; they never call behavior directly.

import { commandRegistry } from "./commandRegistry";
import { useLayoutStore } from "../state/layoutStore";
import { useUiStore } from "../state/uiStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import { pickFolder } from "../lib/ipc";
import {
  closeActiveTab,
  focusAdjacentTab,
  saveActiveDoc,
} from "../hooks/useEditorKeybindings";
import { THEME_LABELS, THEME_ORDER, useThemeStore } from "../state/themeStore";
import { useTerminalStore } from "../state/terminalStore";
import { getActiveDoc, useEditorStore } from "../state/editorStore";
import { usePreviewStore } from "../state/previewStore";
import { runActiveJulia } from "../lib/julia";
import { runLatexBuild } from "../lib/latexBuild";
import { stopActiveRun } from "../lib/run";
import { saveSettings, settingsFilePath } from "../lib/settingsPersistence";
import { runEditorAction } from "../lib/editorBridge";
import { useTreeStore } from "../state/treeStore";
import { useSettingsStore } from "../state/settingsStore";
import { writePty } from "../lib/terminal";
import { isImagePath, isInlinePreviewPath, isPdfPath } from "../lib/fileTypes";

let registered = false;

/** Idempotently register all built-in commands. */
export function registerBuiltinCommands(): void {
  if (registered) return;
  registered = true;

  const layout = () => useLayoutStore.getState();
  const ui = () => useUiStore.getState();

  commandRegistry.register({
    id: "quickOpen.show",
    title: "Go to File…",
    category: "File",
    run: () => ui().openModal("quickOpen"),
  });
  commandRegistry.register({
    id: "commandPalette.show",
    title: "Show All Commands",
    category: "View",
    run: () => ui().openModal("palette"),
  });
  commandRegistry.register({
    id: "file.openFolder",
    title: "Open Folder…",
    category: "File",
    run: async () => {
      const path = await pickFolder();
      if (path) useWorkspaceStore.getState().openWorkspace(path);
    },
  });
  commandRegistry.register({
    id: "file.save",
    title: "Save",
    category: "File",
    run: () => saveActiveDoc(),
  });
  commandRegistry.register({
    id: "file.openSettings",
    title: "Open Settings (JSON)",
    category: "File",
    run: async () => {
      await saveSettings(); // ensure the file exists before opening it
      useWorkspaceStore.getState().requestOpenFile(await settingsFilePath());
    },
  });
  commandRegistry.register({
    id: "editor.closeTab",
    title: "Close Editor",
    category: "Editor",
    run: () => closeActiveTab(),
  });
  commandRegistry.register({
    id: "editor.nextTab",
    title: "Next Editor",
    category: "Editor",
    run: () => focusAdjacentTab(1),
  });
  commandRegistry.register({
    id: "editor.previousTab",
    title: "Previous Editor",
    category: "Editor",
    run: () => focusAdjacentTab(-1),
  });
  commandRegistry.register({
    id: "workbench.toggleSidebar",
    title: "Toggle Sidebar",
    category: "View",
    run: () => layout().toggleSidebar(),
  });
  commandRegistry.register({
    id: "workbench.toggleBottomPanel",
    title: "Toggle Panel",
    category: "View",
    run: () => layout().toggleBottomPanel(),
  });
  commandRegistry.register({
    id: "terminal.toggle",
    title: "Toggle Terminal",
    category: "Terminal",
    run: () => layout().toggleTerminal(),
  });
  commandRegistry.register({
    id: "terminal.new",
    title: "New Terminal",
    category: "Terminal",
    run: () => {
      useTerminalStore
        .getState()
        .createTerminal(useWorkspaceStore.getState().rootPath);
      layout().showBottomTab("terminal");
    },
  });
  commandRegistry.register({
    id: "preview.open",
    title: "Open Preview",
    category: "View",
    run: () => {
      const doc = getActiveDoc(useEditorStore.getState());
      const preview = usePreviewStore.getState();
      if (doc && isInlinePreviewPath(doc.path)) {
        // Markdown/HTML previews render in place, replacing the editor view.
        layout().toggleEditorPreview();
      } else if (doc && isPdfPath(doc.path)) {
        preview.openPdf(doc.path);
        layout().setPdfPanelVisible(true);
      } else if (doc && isImagePath(doc.path)) {
        preview.openImage(doc.path);
        layout().setPdfPanelVisible(true);
      } else {
        layout().togglePdfPanel();
      }
    },
  });
  commandRegistry.register({
    id: "latex.build",
    title: "Build LaTeX",
    category: "Run",
    run: () => runLatexBuild(),
  });
  commandRegistry.register({
    id: "editor.run",
    title: "Run File or Selection (Julia)",
    category: "Run",
    run: () => runActiveJulia(),
  });
  commandRegistry.register({
    id: "run.stop",
    title: "Stop Running Process",
    category: "Run",
    run: () => stopActiveRun(),
  });
  commandRegistry.register({
    id: "workbench.dismiss",
    title: "Dismiss",
    category: "View",
    run: () => ui().closeModal(),
  });

  commandRegistry.register({
    id: "workbench.cycleTheme",
    title: "Cycle Color Theme",
    category: "View",
    run: () => useThemeStore.getState().cycleTheme(),
  });
  for (const t of THEME_ORDER) {
    commandRegistry.register({
      id: `workbench.theme.${t}`,
      title: `Color Theme: ${THEME_LABELS[t]}`,
      category: "View",
      run: () => useThemeStore.getState().setTheme(t),
    });
  }

  // --- Editor actions (delegated to the active Monaco instance) ---
  commandRegistry.register({
    id: "editor.formatDocument",
    title: "Format Document",
    category: "Editor",
    run: () => runEditorAction("editor.action.formatDocument"),
  });
  commandRegistry.register({
    id: "editor.goToLine",
    title: "Go to Line…",
    category: "Go",
    run: () => runEditorAction("editor.action.gotoLine"),
  });
  commandRegistry.register({
    id: "editor.renameSymbol",
    title: "Rename Symbol",
    category: "Editor",
    run: () => runEditorAction("editor.action.rename"),
  });
  commandRegistry.register({
    id: "editor.goToSymbol",
    title: "Go to Symbol in Editor…",
    category: "Go",
    run: () => runEditorAction("editor.action.quickOutline"),
  });

  // --- Workspace search ---
  commandRegistry.register({
    id: "workbench.searchWorkspace",
    title: "Find in Files",
    category: "View",
    run: () => {
      layout().setSidebarVisible(true);
      layout().setActiveView("search");
    },
  });

  // --- Explorer ---
  commandRegistry.register({
    id: "explorer.refresh",
    title: "Refresh Explorer",
    category: "File",
    run: () => useTreeStore.getState().refresh(),
  });
  commandRegistry.register({
    id: "explorer.collapseAll",
    title: "Collapse Folders in Explorer",
    category: "File",
    run: () => useTreeStore.getState().collapseAll(),
  });
  commandRegistry.register({
    id: "explorer.revealActiveFile",
    title: "Reveal Active File in Explorer",
    category: "File",
    run: () => {
      const doc = getActiveDoc(useEditorStore.getState());
      const root = useWorkspaceStore.getState().rootPath;
      if (doc && root && doc.path.startsWith(root)) {
        const rel = doc.path.slice(root.length).replace(/^[/\\]/, "");
        const segments = rel.split(/[/\\]/).slice(0, -1);
        const ancestors = [root];
        let cur = root;
        for (const segment of segments) {
          cur = `${cur}/${segment}`;
          ancestors.push(cur);
        }
        useTreeStore.getState().expandPaths(ancestors);
      }
      layout().setSidebarVisible(true);
      layout().setActiveView("explorer");
    },
  });

  // --- Julia REPL + send-to-terminal ---
  commandRegistry.register({
    id: "julia.repl",
    title: "Open Julia REPL",
    category: "Run",
    run: () => {
      const juliaPath = useSettingsStore.getState().settings.juliaPath || "julia";
      const root = useWorkspaceStore.getState().rootPath;
      useTerminalStore.getState().createTerminal(root, {
        title: "Julia REPL",
        startupCommand: `${juliaPath}\r`,
      });
      layout().showBottomTab("terminal");
    },
  });
  commandRegistry.register({
    id: "terminal.runSelection",
    title: "Send Selection to Terminal",
    category: "Run",
    run: () => {
      const selection = useEditorStore.getState().selection;
      const id = useTerminalStore.getState().activeId;
      if (id && selection.trim()) {
        void writePty(id, selection.endsWith("\n") ? selection : `${selection}\n`);
      }
    },
  });
}

registerBuiltinCommands();
