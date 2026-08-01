import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("./useLayoutKeybindings", () => ({
  isMac: () => false,
}));

import { commandRegistry } from "../commands/commandRegistry";
import { initialEditorData, useEditorStore } from "../state/editorStore";
import { initialKeymapData, useKeymapStore } from "../state/keymapStore";
import { initialUiData, useUiStore } from "../state/uiStore";
import { useCommandKeybindings } from "./useCommandKeybindings";

describe("useCommandKeybindings", () => {
  let executeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    executeSpy = vi.spyOn(commandRegistry, "execute").mockResolvedValue();
    useEditorStore.setState(initialEditorData, false);
    useKeymapStore.setState(initialKeymapData, false);
    useUiStore.setState(initialUiData, false);
  });

  afterEach(() => {
    executeSpy.mockRestore();
  });

  it("consumes empty-command user unbinds without dispatching", () => {
    useKeymapStore.getState().setUserKeybindings([
      { key: "mod+p", command: "" },
    ]);
    const { unmount } = renderHook(() => useCommandKeybindings());
    const event = new KeyboardEvent("keydown", {
      key: "p",
      ctrlKey: true,
      cancelable: true,
    });

    window.dispatchEvent(event);
    unmount();

    expect(event.defaultPrevented).toBe(true);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("dispatches workbench shortcuts before a focused editor widget stops bubbling", () => {
    const editorWidget = document.createElement("textarea");
    editorWidget.addEventListener("keydown", (event) => event.stopPropagation());
    document.body.appendChild(editorWidget);
    const { unmount } = renderHook(() => useCommandKeybindings());
    const event = new KeyboardEvent("keydown", {
      key: "s",
      code: "KeyS",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    editorWidget.dispatchEvent(event);
    unmount();
    editorWidget.remove();

    expect(event.defaultPrevented).toBe(true);
    expect(executeSpy).toHaveBeenCalledOnce();
    expect(executeSpy).toHaveBeenCalledWith("file.save");
  });

  it("captures Cmd+` before a focused terminal textarea can consume it", () => {
    const terminal = document.createElement("div");
    terminal.className = "terminal-view";
    const textarea = document.createElement("textarea");
    textarea.addEventListener("keydown", (event) => event.stopPropagation());
    terminal.appendChild(textarea);
    document.body.appendChild(terminal);
    const { unmount } = renderHook(() => useCommandKeybindings());
    const event = new KeyboardEvent("keydown", {
      key: "`",
      code: "Backquote",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });

    textarea.dispatchEvent(event);
    unmount();
    terminal.remove();

    expect(event.defaultPrevented).toBe(true);
    expect(executeSpy).toHaveBeenCalledOnce();
    expect(executeSpy).toHaveBeenCalledWith("window.next");
  });

  it("dispatches Open Folder through the central workbench keymap", () => {
    const { unmount } = renderHook(() => useCommandKeybindings());
    const event = new KeyboardEvent("keydown", {
      key: "o",
      code: "KeyO",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    window.dispatchEvent(event);
    unmount();

    expect(event.defaultPrevented).toBe(true);
    expect(executeSpy).toHaveBeenCalledOnce();
    expect(executeSpy).toHaveBeenCalledWith("file.openFolder");
  });

  it("does not report editorFocus when an Explorer input owns the keyboard", () => {
    useEditorStore.getState().openDoc({
      path: "/workspace/open.ts",
      content: "",
      language: "typescript",
    });
    useKeymapStore.getState().setUserKeybindings([
      {
        key: "ctrl+k",
        command: "outside-editor",
        when: "!editorFocus && textInputFocus",
      },
    ]);
    const explorer = document.createElement("div");
    explorer.className = "explorer";
    const input = document.createElement("input");
    explorer.appendChild(input);
    document.body.appendChild(explorer);
    const { unmount } = renderHook(() => useCommandKeybindings());
    const event = new KeyboardEvent("keydown", {
      key: "k",
      code: "KeyK",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    input.dispatchEvent(event);
    unmount();
    explorer.remove();

    expect(event.defaultPrevented).toBe(true);
    expect(executeSpy).toHaveBeenCalledOnce();
    expect(executeSpy).toHaveBeenCalledWith("outside-editor");
  });

  it("reports terminal and text-input focus from the actual event target", () => {
    useKeymapStore.getState().setUserKeybindings([
      {
        key: "ctrl+k",
        command: "terminal-input",
        when: "terminalFocus && textInputFocus && !editorFocus",
      },
    ]);
    const terminal = document.createElement("div");
    terminal.className = "terminal-view";
    const textarea = document.createElement("textarea");
    terminal.appendChild(textarea);
    document.body.appendChild(terminal);
    const { unmount } = renderHook(() => useCommandKeybindings());
    const event = new KeyboardEvent("keydown", {
      key: "k",
      code: "KeyK",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    textarea.dispatchEvent(event);
    unmount();
    terminal.remove();

    expect(event.defaultPrevented).toBe(true);
    expect(executeSpy).toHaveBeenCalledOnce();
    expect(executeSpy).toHaveBeenCalledWith("terminal-input");
  });

  it("reports editor and text-input focus inside the Monaco host", () => {
    useKeymapStore.getState().setUserKeybindings([
      {
        key: "ctrl+k",
        command: "editor-input",
        when: "editorFocus && textInputFocus && !terminalFocus",
      },
    ]);
    const editor = document.createElement("div");
    editor.className = "monaco-host";
    const textarea = document.createElement("textarea");
    editor.appendChild(textarea);
    document.body.appendChild(editor);
    const { unmount } = renderHook(() => useCommandKeybindings());
    const event = new KeyboardEvent("keydown", {
      key: "k",
      code: "KeyK",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    textarea.dispatchEvent(event);
    unmount();
    editor.remove();

    expect(event.defaultPrevented).toBe(true);
    expect(executeSpy).toHaveBeenCalledOnce();
    expect(executeSpy).toHaveBeenCalledWith("editor-input");
  });
});
