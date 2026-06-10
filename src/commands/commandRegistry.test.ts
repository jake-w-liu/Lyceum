// Tests for the command registry.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { commandRegistry } from "./commandRegistry";

describe("commandRegistry", () => {
  beforeEach(() => {
    commandRegistry.clear();
  });

  it("registers and gets a command", () => {
    const cmd = { id: "a", title: "A", run: () => {} };
    commandRegistry.register(cmd);
    expect(commandRegistry.get("a")).toBe(cmd);
  });

  it("returns undefined for an unknown id", () => {
    expect(commandRegistry.get("missing")).toBeUndefined();
  });

  it("lists commands in insertion order", () => {
    commandRegistry.register({ id: "a", title: "A", run: () => {} });
    commandRegistry.register({ id: "b", title: "B", run: () => {} });
    commandRegistry.register({ id: "c", title: "C", run: () => {} });
    expect(commandRegistry.list().map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("execute calls run", async () => {
    const run = vi.fn();
    commandRegistry.register({ id: "a", title: "A", run });
    await commandRegistry.execute("a");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("execute contains a rejecting command and logs the command id", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    commandRegistry.register({
      id: "boom.async",
      title: "Boom",
      run: async () => {
        throw new Error("nope");
      },
    });
    commandRegistry.register({
      id: "boom.sync",
      title: "Boom Sync",
      run: () => {
        throw new Error("sync nope");
      },
    });

    await expect(commandRegistry.execute("boom.async")).resolves.toBeUndefined();
    await expect(commandRegistry.execute("boom.sync")).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledTimes(2);
    expect(String(error.mock.calls[0][0])).toContain("boom.async");
    expect(String(error.mock.calls[1][0])).toContain("boom.sync");
    error.mockRestore();
  });

  it("execute on an unknown id does not throw and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(commandRegistry.execute("nope")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("register with an existing id overwrites", () => {
    const first = { id: "a", title: "First", run: () => {} };
    const second = { id: "a", title: "Second", run: () => {} };
    commandRegistry.register(first);
    commandRegistry.register(second);
    expect(commandRegistry.get("a")).toBe(second);
    expect(commandRegistry.list()).toHaveLength(1);
  });
});
