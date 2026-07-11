import { describe, expect, it } from "vitest";
import {
  deriveOutputPdf,
  pdfPathForTexPath,
} from "./latex";

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

  it("derives from quoted tex command tokens", () => {
    expect(deriveOutputPdf('tectonic "main.tex"', null)).toBe("main.pdf");
    expect(deriveOutputPdf("tectonic 'paper.tex'", null)).toBe("paper.pdf");
  });

  it("returns null when no tex source exists", () => {
    expect(deriveOutputPdf("echo hi", null)).toBeNull();
  });

  it("returns null when active path is not a tex file", () => {
    expect(deriveOutputPdf("echo hi", "/w/notes.md")).toBeNull();
  });
});

describe("LaTeX output path helpers", () => {
  it("derives the output PDF beside the active tex file", () => {
    expect(pdfPathForTexPath("/w/chapters/intro.tex")).toBe(
      "/w/chapters/intro.pdf",
    );
  });

  it("derives output beside files at either form of a Windows drive root", () => {
    expect(pdfPathForTexPath("C:\\paper.tex")).toBe("C:\\paper.pdf");
    expect(pdfPathForTexPath("C:/paper.tex")).toBe("C:/paper.pdf");
  });
});
