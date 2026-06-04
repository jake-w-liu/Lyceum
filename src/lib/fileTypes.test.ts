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
