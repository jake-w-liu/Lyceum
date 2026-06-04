import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerBuiltinCommands } from "./builtinCommands";
import { commandRegistry } from "./commandRegistry";
import { DEFAULT_KEYMAP } from "../keybindings/keybindingRegistry";
import { initialTerminalData, useTerminalStore } from "../state/terminalStore";
import { initialLayoutData, useLayoutStore } from "../state/layoutStore";
import { initialThemeData, useThemeStore } from "../state/themeStore";
import { initialEditorData, useEditorStore } from "../state/editorStore";
import { initialPreviewData, usePreviewStore } from "../state/previewStore";

const runLatexBuildMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/latexBuild", () => ({
  runLatexBuild: (...args: unknown[]) => runLatexBuildMock(...args),
}));

beforeEach(() => {
  registerBuiltinCommands(); // idempotent; ensures the registry is populated
  useTerminalStore.setState(initialTerminalData, false);
  useLayoutStore.setState(initialLayoutData, false);
  useThemeStore.setState(initialThemeData, false);
  useEditorStore.setState(initialEditorData, false);
  usePreviewStore.setState(initialPreviewData, false);
  runLatexBuildMock.mockClear();
});

describe("builtinCommands", () => {
  it("terminal.new creates a terminal and reveals the terminal panel", async () => {
    expect(useTerminalStore.getState().terminals).toHaveLength(0);
    await commandRegistry.execute("terminal.new");
    expect(useTerminalStore.getState().terminals).toHaveLength(1);
    expect(useLayoutStore.getState().bottomPanelVisible).toBe(true);
    expect(useLayoutStore.getState().activeBottomTab).toBe("terminal");
  });

  it("workbench.toggleSidebar toggles the sidebar", async () => {
    const before = useLayoutStore.getState().sidebarVisible;
    await commandRegistry.execute("workbench.toggleSidebar");
    expect(useLayoutStore.getState().sidebarVisible).toBe(!before);
  });

  it("workbench.cycleTheme advances the active theme", async () => {
    expect(useThemeStore.getState().theme).toBe("dark");
    await commandRegistry.execute("workbench.cycleTheme");
    expect(useThemeStore.getState().theme).toBe("light");
  });

  it("preview.open toggles inline preview for HTML documents", async () => {
    useEditorStore.getState().openDoc({
      path: "/w/index.html",
      content: "<h1>hi</h1>",
      language: "html",
    });

    await commandRegistry.execute("preview.open");

    expect(useLayoutStore.getState().editorPreview).toBe(true);
    expect(useLayoutStore.getState().pdfPanelVisible).toBe(false);
    expect(usePreviewStore.getState().pdfPath).toBeNull();
    expect(usePreviewStore.getState().imagePath).toBeNull();
  });

  it("preview.open keeps PDF/image viewer tabs in the editor area", async () => {
    useLayoutStore.getState().setPdfPanelVisible(true);
    usePreviewStore.getState().openPdf("/old/side-panel.pdf");
    useEditorStore.getState().openDoc({
      path: "/w/paper.pdf",
      content: "",
      language: "pdf",
      kind: "pdf",
    });

    await commandRegistry.execute("preview.open");

    expect(useEditorStore.getState().activePath).toBe("/w/paper.pdf");
    expect(useLayoutStore.getState().pdfPanelVisible).toBe(false);
    expect(usePreviewStore.getState().pdfPath).toBeNull();
  });

  it("preview.open builds the active LaTeX file", async () => {
    useEditorStore.getState().openDoc({
      path: "/w/paper.tex",
      content: "\\documentclass{article}",
      language: "latex",
    });

    await commandRegistry.execute("preview.open");

    expect(runLatexBuildMock).toHaveBeenCalledWith({
      targetPath: "/w/paper.tex",
      openOnSuccess: true,
    });
    expect(useLayoutStore.getState().pdfPanelVisible).toBe(false);
  });

  it("latex.build compiles the active LaTeX file without opening preview", async () => {
    useEditorStore.getState().openDoc({
      path: "/w/paper.tex",
      content: "\\documentclass{article}",
      language: "latex",
    });

    await commandRegistry.execute("latex.build");

    expect(runLatexBuildMock).toHaveBeenCalledWith({ openOnSuccess: false });
  });

  it("preview.open is a no-op for unsupported active files", async () => {
    useEditorStore.getState().openDoc({
      path: "/w/main.ts",
      content: "console.log(1)",
      language: "typescript",
    });

    await commandRegistry.execute("preview.open");

    expect(useLayoutStore.getState().editorPreview).toBe(false);
    expect(useLayoutStore.getState().pdfPanelVisible).toBe(false);
    expect(usePreviewStore.getState().pdfPath).toBeNull();
    expect(usePreviewStore.getState().imagePath).toBeNull();
  });

  it("every default keybinding resolves to a registered command", () => {
    for (const binding of DEFAULT_KEYMAP) {
      expect(
        commandRegistry.get(binding.command),
        `keymap references an unregistered command: ${binding.command}`,
      ).toBeDefined();
    }
  });
});
