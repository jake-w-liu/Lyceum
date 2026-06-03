// Performance guard (M12): assert the heavy modules (Monaco, terminal/xterm,
// pdf.js, markdown-it) stay behind React.lazy dynamic imports so they are
// code-split out of the initial bundle. Structural regression test — fails if a
// lazy import is converted back to a static one. Sources are imported as raw
// text via Vite's `?raw` (no node:fs needed, so it type-checks too).

import { describe, expect, it } from "vitest";
import editorArea from "./components/EditorArea.tsx?raw";
import bottomPanel from "./components/BottomPanel.tsx?raw";
import pdfPanel from "./components/PdfPanel.tsx?raw";

describe("lazy loading keeps heavy deps out of the initial bundle", () => {
  it("Monaco is lazy-loaded from the editor area", () => {
    expect(editorArea).toMatch(
      /lazy\(\s*\(\)\s*=>\s*import\("\.\/MonacoEditor"\)/,
    );
  });

  it("the terminal (xterm) is lazy-loaded from the bottom panel", () => {
    expect(bottomPanel).toMatch(/lazy\([\s\S]*?import\("\.\/TerminalPanel"\)/);
  });

  it("the PDF viewer and Markdown view are lazy-loaded from the preview panel", () => {
    expect(pdfPanel).toMatch(/lazy\([\s\S]*?import\("\.\/PdfViewer"\)/);
    expect(pdfPanel).toMatch(/lazy\([\s\S]*?import\("\.\/MarkdownView"\)/);
  });
});
