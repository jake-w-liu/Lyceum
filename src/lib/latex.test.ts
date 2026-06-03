import { describe, expect, it } from "vitest";
import { deriveOutputPdf } from "./latex";

describe("deriveOutputPdf", () => {
  it("derives from build command token", () => {
    expect(deriveOutputPdf("latexmk -pdf main.tex", null)).toBe("main.pdf");
  });

  it("falls back to active tex path", () => {
    expect(deriveOutputPdf("latexmk -pdf", "/w/paper.tex")).toBe("paper.pdf");
  });

  it("strips directory and handles uppercase extension", () => {
    expect(deriveOutputPdf("latexmk -pdf chapters/intro.TEX", null)).toBe(
      "intro.pdf",
    );
  });

  it("returns null when no tex source exists", () => {
    expect(deriveOutputPdf("echo hi", null)).toBeNull();
  });

  it("returns null when active path is not a tex file", () => {
    expect(deriveOutputPdf("echo hi", "/w/notes.md")).toBeNull();
  });
});
