import { describe, expect, it } from "vitest";

import {
  extensionForPath,
  imageMimeForPath,
  isHtmlPath,
  isImagePath,
  isInlinePreviewPath,
  isJuliaSourcePath,
  isMarkdownPath,
  isPdfPath,
  isTexSourcePath,
  relativePath,
} from "./fileTypes";

describe("file type helpers", () => {
  it("extracts a lowercase extension from POSIX and Windows paths", () => {
    expect(extensionForPath("/w/Figure.PNG")).toBe("png");
    expect(extensionForPath("C:\\w\\photo.JPG")).toBe("jpg");
    expect(extensionForPath("/w/noext")).toBe("");
    expect(extensionForPath("/w/.gitignore")).toBe("");
  });

  it("recognizes previewable document paths", () => {
    expect(isPdfPath("/w/paper.PDF")).toBe(true);
    expect(isMarkdownPath("/w/notes.markdown")).toBe(true);
    expect(isMarkdownPath("/w/notes.md")).toBe(true);
    expect(isHtmlPath("/w/index.HTML")).toBe(true);
    expect(isHtmlPath("/w/template.htm")).toBe(true);
    expect(isTexSourcePath("/w/paper.TEX")).toBe(true);
    expect(isTexSourcePath("/w/package.sty")).toBe(false);
    expect(isJuliaSourcePath("/w/analysis.JL")).toBe(true);
    expect(isJuliaSourcePath("/w/analysis.py")).toBe(false);
    expect(isInlinePreviewPath("/w/notes.md")).toBe(true);
    expect(isInlinePreviewPath("/w/index.html")).toBe(true);
    expect(isInlinePreviewPath("/w/main.ts")).toBe(false);
  });

  it("maps common browser image paths to MIME types", () => {
    expect(imageMimeForPath("/w/figure.png")).toBe("image/png");
    expect(imageMimeForPath("/w/photo.JPG")).toBe("image/jpeg");
    expect(imageMimeForPath("/w/plot.jpeg")).toBe("image/jpeg");
    expect(imageMimeForPath("/w/anim.gif")).toBe("image/gif");
    expect(imageMimeForPath("/w/diagram.webp")).toBe("image/webp");
    expect(imageMimeForPath("/w/vector.svg")).toBe("image/svg+xml");
    expect(isImagePath("/w/icon.ico")).toBe(true);
    expect(isImagePath("/w/vector.svg")).toBe(true);
    expect(isImagePath("/w/index.html")).toBe(false);
  });
});

describe("relativePath", () => {
  it("returns the path relative to the workspace root", () => {
    expect(relativePath("/w", "/w/src/main.ts")).toBe("src/main.ts");
    expect(relativePath("/w/", "/w/src/main.ts")).toBe("src/main.ts");
  });

  it("returns the bare name for the root itself", () => {
    expect(relativePath("/w/proj", "/w/proj")).toBe("proj");
  });

  it("returns the absolute path when the file is outside the root", () => {
    expect(relativePath("/w", "/other/x.ts")).toBe("/other/x.ts");
  });

  it("normalizes Windows separators in the relative portion", () => {
    expect(relativePath("C:\\w", "C:\\w\\src\\a.ts")).toBe("src/a.ts");
  });

  it("returns the path unchanged when there is no root", () => {
    expect(relativePath("", "/w/a.ts")).toBe("/w/a.ts");
  });
});
