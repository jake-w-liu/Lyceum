import { beforeEach, describe, expect, it } from "vitest";
import { initialTerminalData, useTerminalStore } from "./terminalStore";

const get = () => useTerminalStore.getState();

beforeEach(() => useTerminalStore.setState(initialTerminalData, false));

describe("terminalStore", () => {
  it("creates terminals with sequential ids and activates them", () => {
    const a = get().createTerminal("/w");
    expect(a).toBe("term-1");
    expect(get().activeId).toBe("term-1");
    expect(get().terminals[0]).toMatchObject({
      id: "term-1",
      title: "Terminal 1",
      cwd: "/w",
    });
    const b = get().createTerminal();
    expect(b).toBe("term-2");
    expect(get().terminals).toHaveLength(2);
    expect(get().activeId).toBe("term-2");
  });

  it("reassigns active when closing the active terminal", () => {
    get().createTerminal();
    get().createTerminal();
    get().setActive("term-2");
    get().closeTerminal("term-2");
    expect(get().activeId).toBe("term-1");
    get().closeTerminal("term-1");
    expect(get().activeId).toBeNull();
    expect(get().terminals).toHaveLength(0);
  });

  it("keeps active when closing a non-active terminal", () => {
    get().createTerminal();
    get().createTerminal();
    get().setActive("term-2");
    get().closeTerminal("term-1");
    expect(get().activeId).toBe("term-2");
  });

  it("renames a terminal", () => {
    get().createTerminal();
    get().renameTerminal("term-1", "build");
    expect(get().terminals[0].title).toBe("build");
  });
});
