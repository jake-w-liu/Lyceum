// Tests for LSP server configurations and selectors.

import { describe, expect, it } from "vitest";
import { serverForExtension, serverForLanguage, serverForPath } from "./servers";

describe("LSP server selectors", () => {
  it("resolves servers by path extension", () => {
    expect(serverForPath("/w/main.jl")?.id).toBe("julia");
    expect(serverForPath("/w/app.py")?.id).toBe("pyright");
    expect(serverForPath("/w/app.ts")?.id).toBe("typescript");
    expect(serverForPath("/w/lib.rs")?.id).toBe("rust-analyzer");
    expect(serverForPath("/w/main.go")?.id).toBe("gopls");
  });

  it("resolves servers by extension case-insensitively", () => {
    expect(serverForExtension("CS")?.id).toBe("csharp");
    expect(serverForExtension("CPP")?.id).toBe("clangd");
  });

  it("resolves servers by language id", () => {
    expect(serverForLanguage("julia")?.id).toBe("julia");
    expect(serverForLanguage("javascript")?.id).toBe("typescript");
  });

  it("returns undefined for unknown extensions", () => {
    expect(serverForPath("/w/readme.md")).toBeUndefined();
  });

  it("exposes stable backend server ids", () => {
    expect(serverForLanguage("julia")?.id).toBe("julia");
    expect(serverForLanguage("python")?.id).toBe("pyright");
    expect(serverForLanguage("typescript")?.id).toBe("typescript");
    expect(serverForLanguage("rust")?.id).toBe("rust-analyzer");
    expect(serverForLanguage("c")?.id).toBe("clangd");
    expect(serverForLanguage("cpp")?.id).toBe("clangd");
    expect(serverForLanguage("go")?.id).toBe("gopls");
    expect(serverForLanguage("csharp")?.id).toBe("csharp");
    expect(serverForLanguage("r")?.id).toBe("r");
  });
});
