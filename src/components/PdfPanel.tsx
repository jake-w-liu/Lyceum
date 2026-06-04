// Auxiliary right-side preview panel (M6 + M11). The normal PDF/image open path
// is now editor viewer tabs, but this panel remains available for the shell's
// preview surface. Viewers are lazy so heavy deps stay out of the initial bundle.

import { Suspense, lazy } from "react";
import { Icon } from "./Icon";
import { useLayoutStore } from "../state/layoutStore";
import { usePreviewStore } from "../state/previewStore";
import { baseName } from "../state/workspaceStore";

const PdfViewer = lazy(() => import("./PdfViewer"));
const ImageViewer = lazy(() =>
  import("./ImageViewer").then((m) => ({ default: m.ImageViewer })),
);
const MarkdownView = lazy(() =>
  import("./MarkdownView").then((m) => ({ default: m.MarkdownView })),
);

export function PdfPanel() {
  const pdfPanelWidth = useLayoutStore((s) => s.pdfPanelWidth);
  const togglePdfPanel = useLayoutStore((s) => s.togglePdfPanel);
  const pdfPath = usePreviewStore((s) => s.pdfPath);
  const markdownPath = usePreviewStore((s) => s.markdownPath);
  const imagePath = usePreviewStore((s) => s.imagePath);
  const title = pdfPath
    ? baseName(pdfPath)
    : imagePath
      ? baseName(imagePath)
    : markdownPath
      ? baseName(markdownPath)
      : "Preview";

  return (
    <aside
      className="pdf-panel"
      aria-label="Preview"
      style={{ width: pdfPanelWidth }}
    >
      <div className="panel-header">
        <span className="panel-title">{title}</span>
        <button
          className="icon-button"
          type="button"
          aria-label="Close Preview"
          onClick={togglePdfPanel}
        >
          <Icon name="close" />
        </button>
      </div>
      {pdfPath ? (
        <Suspense fallback={<div className="pdf-message">Loading PDF…</div>}>
          <PdfViewer key={pdfPath} path={pdfPath} />
        </Suspense>
      ) : imagePath ? (
        <Suspense fallback={<div className="pdf-message">Loading image…</div>}>
          <ImageViewer key={imagePath} path={imagePath} />
        </Suspense>
      ) : markdownPath ? (
        <Suspense fallback={<div className="pdf-message">Loading…</div>}>
          <MarkdownView key={markdownPath} path={markdownPath} />
        </Suspense>
      ) : (
        <div className="panel-body">
          <div className="placeholder">
            Open a Markdown, PDF, or image file, then run “Open Preview”
            (⌘/Ctrl+Shift+V).
          </div>
        </div>
      )}
    </aside>
  );
}
