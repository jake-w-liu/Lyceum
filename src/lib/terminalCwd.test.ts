import { describe, expect, it } from "vitest";
import { resolveTerminalCwd } from "./terminalCwd";

describe("resolveTerminalCwd", () => {
  it("returns rootPath for workspaceRoot", () => {
    expect(resolveTerminalCwd("workspaceRoot", "/w", null)).toBe("/w");
  });

  it("returns parent dir for currentFileDir", () => {
    expect(resolveTerminalCwd("currentFileDir", "/w", "/w/src/a.jl")).toBe("/w/src");
  });

  it("falls back to rootPath when no active file", () => {
    expect(resolveTerminalCwd("currentFileDir", "/w", null)).toBe("/w");
  });

  it("returns null when nothing applies", () => {
    expect(resolveTerminalCwd("workspaceRoot", null, null)).toBeNull();
  });

  it("resolves parent dir without rootPath", () => {
    expect(resolveTerminalCwd("currentFileDir", null, "/x/y.txt")).toBe("/x");
  });

  it("handles Windows backslash paths", () => {
    expect(
      resolveTerminalCwd("currentFileDir", "C:\\w", "C:\\w\\src\\a.jl"),
    ).toBe("C:\\w\\src");
  });

  it("returns the drive root for a file directly at a Windows drive root", () => {
    expect(resolveTerminalCwd("currentFileDir", "C:\\w", "C:\\a.txt")).toBe(
      "C:\\",
    );
  });

  it("returns root for a file at the filesystem root", () => {
    expect(resolveTerminalCwd("currentFileDir", "/w", "/foo.jl")).toBe("/");
  });

  it("falls back to rootPath for a bare filename", () => {
    expect(resolveTerminalCwd("currentFileDir", "/w", "foo.jl")).toBe("/w");
  });
});
