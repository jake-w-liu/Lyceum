import { describe, expect, it } from "vitest";
import { fileIconFor } from "./fileIcons";

describe("fileIconFor", () => {
  it("maps images, PDFs, and markdown to dedicated glyphs", () => {
    expect(fileIconFor("photo.png")).toBe("image");
    expect(fileIconFor("scan.JPG")).toBe("image");
    expect(fileIconFor("paper.pdf")).toBe("pdf");
    expect(fileIconFor("notes.md")).toBe("markdown");
    expect(fileIconFor("readme.markdown")).toBe("markdown");
  });

  it("maps source/config extensions to the code glyph", () => {
    expect(fileIconFor("main.jl")).toBe("file-code");
    expect(fileIconFor("script.py")).toBe("file-code");
    expect(fileIconFor("paper.tex")).toBe("file-code");
    expect(fileIconFor("config.toml")).toBe("file-code");
  });

  it("falls back to the generic file glyph for unknown types", () => {
    expect(fileIconFor("data.csv")).toBe("file");
    expect(fileIconFor("LICENSE")).toBe("file");
    expect(fileIconFor("archive.zip")).toBe("file");
  });
});
