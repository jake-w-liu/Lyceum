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
});
