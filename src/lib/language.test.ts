// Tests for languageForPath: extension-to-Monaco-language mapping.

import { describe, expect, it } from "vitest";

import { languageForPath } from "./language";

describe("languageForPath", () => {
  it("maps extensions to Monaco language ids", () => {
    expect(languageForPath("a.ts")).toBe("typescript");
    expect(languageForPath("X.TSX")).toBe("typescript");
    expect(languageForPath("main.jl")).toBe("julia");
    expect(languageForPath("x.py")).toBe("python");
    expect(languageForPath("lib.rs")).toBe("rust");
    expect(languageForPath("a.cpp")).toBe("cpp");
    expect(languageForPath("p.cs")).toBe("csharp");
    expect(languageForPath("r.md")).toBe("markdown");
    expect(languageForPath("c.json")).toBe("json");
    expect(languageForPath("s.sh")).toBe("shell");
    expect(languageForPath("a.toml")).toBe("toml");
    expect(languageForPath("doc.tex")).toBe("latex");
    expect(languageForPath("paper.latex")).toBe("latex");
  });

  it("falls back to plaintext when there is no extension", () => {
    expect(languageForPath("noext")).toBe("plaintext");
    expect(languageForPath("Makefile")).toBe("plaintext");
  });
});
