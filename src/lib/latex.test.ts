import { describe, expect, it } from "vitest";
import {
  buildCommandForTexPath,
  buildCommandForTexTool,
  deriveOutputPdf,
  pdfPathForTexPath,
  selectLatexBuildCommand,
  shouldAutoSelectLatexTool,
  texBuildDirectory,
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

describe("current-file LaTeX build helpers", () => {
  it("retargets the configured tex argument to the active file basename", () => {
    expect(buildCommandForTexPath("latexmk -pdf main.tex", "/w/paper.tex")).toBe(
      'latexmk -pdf "paper.tex"',
    );
  });

  it("appends the active file when the configured command has no tex argument", () => {
    expect(buildCommandForTexPath("latexmk -pdf", "/w/paper.tex")).toBe(
      'latexmk -pdf "paper.tex"',
    );
  });

  it("quotes active filenames for shell execution", () => {
    expect(
      buildCommandForTexPath("latexmk -pdf main.tex", "/w/my paper.tex"),
    ).toBe('latexmk -pdf "my paper.tex"');
  });

  it("retargets quoted configured tex arguments", () => {
    expect(
      buildCommandForTexPath('tectonic "main.tex"', "/w/paper.tex"),
    ).toBe('tectonic "paper.tex"');
  });

  it("derives the output PDF beside the active tex file", () => {
    expect(pdfPathForTexPath("/w/chapters/intro.tex")).toBe(
      "/w/chapters/intro.pdf",
    );
    expect(texBuildDirectory("/w/chapters/intro.tex")).toBe("/w/chapters");
  });
});

describe("LaTeX tool selection", () => {
  it("recognizes only the stock command as auto-selectable", () => {
    expect(shouldAutoSelectLatexTool(" latexmk   -pdf   main.tex ")).toBe(true);
    expect(shouldAutoSelectLatexTool('latexmk -pdf "main.tex"')).toBe(true);
    expect(shouldAutoSelectLatexTool("latexmk -pdf -silent main.tex")).toBe(
      false,
    );
  });

  it("builds commands for supported engines", () => {
    expect(buildCommandForTexTool("tectonic", "/w/main.tex")).toBe(
      'tectonic "main.tex"',
    );
    expect(buildCommandForTexTool("pdflatex", "/w/main.tex")).toBe(
      'pdflatex -interaction=nonstopmode -halt-on-error "main.tex"',
    );
  });

  it("falls back from stock latexmk to an available engine", () => {
    expect(
      selectLatexBuildCommand("latexmk -pdf main.tex", "/w/main.tex", [
        "tectonic",
      ]),
    ).toBe('tectonic "main.tex"');
  });

  it("honors custom commands without auto-selection", () => {
    expect(
      selectLatexBuildCommand("latexmk -pdf -silent main.tex", "/w/paper.tex", [
        "tectonic",
      ]),
    ).toBe('latexmk -pdf -silent "paper.tex"');
  });
});
