import { beforeEach, describe, expect, it } from "vitest";
import { registerBuiltinCommands } from "./builtinCommands";
import { commandRegistry } from "./commandRegistry";
import { DEFAULT_KEYMAP } from "../keybindings/keybindingRegistry";
import { initialTerminalData, useTerminalStore } from "../state/terminalStore";
import { initialLayoutData, useLayoutStore } from "../state/layoutStore";
import { initialThemeData, useThemeStore } from "../state/themeStore";

beforeEach(() => {
  registerBuiltinCommands(); // idempotent; ensures the registry is populated
  useTerminalStore.setState(initialTerminalData, false);
  useLayoutStore.setState(initialLayoutData, false);
  useThemeStore.setState(initialThemeData, false);
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

  it("every default keybinding resolves to a registered command", () => {
    for (const binding of DEFAULT_KEYMAP) {
      expect(
        commandRegistry.get(binding.command),
        `keymap references an unregistered command: ${binding.command}`,
      ).toBeDefined();
    }
  });
});
