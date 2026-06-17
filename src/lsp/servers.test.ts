// Tests for LSP server configurations and selectors.

import { describe, expect, it } from "vitest";
import { serverForExtension, serverForLanguage, serverForPath } from "./servers";

describe("LSP server selectors", () => {
  it("resolves servers by path extension", () => {
    expect(serverForPath("/w/main.jl")?.id).toBe("julia");
    expect(serverForPath("/w/app.py")?.id).toBe("pyright");
  });

  it("resolves servers by extension case-insensitively", () => {
    expect(serverForExtension("CS")?.id).toBe("csharp");
  });

  it("resolves servers by language id", () => {
    expect(serverForLanguage("julia")?.id).toBe("julia");
  });

  it("returns undefined for unknown extensions", () => {
    expect(serverForPath("/w/readme.md")).toBeUndefined();
  });

  it("exposes stable backend server ids", () => {
    expect(serverForLanguage("julia")?.id).toBe("julia");
    expect(serverForLanguage("python")?.id).toBe("pyright");
    expect(serverForLanguage("csharp")?.id).toBe("csharp");
  });
});
