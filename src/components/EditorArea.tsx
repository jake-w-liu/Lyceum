// Main editor area. With documents open it shows the tab strip and the
// lazily-loaded Monaco editor; with none open it shows the welcome screen with
// the layout-toggle keyboard hints.

import { Suspense, lazy, useLayoutEffect, useRef, useState } from "react";
import { isMac } from "../hooks/useLayoutKeybindings";
import {
  isHtmlPath,
  isInlinePreviewPath,
  isMarkdownPath,
} from "../lib/fileTypes";
import { isTextDoc, useEditorStore } from "../state/editorStore";
import { getActiveEditor } from "../lib/editorBridge";
import { useLayoutStore } from "../state/layoutStore";
import { TabBar } from "./TabBar";
import type { MarkdownSourcePosition } from "./MarkdownView";

// Lazy so the Monaco bundle + workers load only once a document is opened.
const MonacoEditor = lazy(() => import("./MonacoEditor"));
const MarkdownView = lazy(() =>
  import("./MarkdownView").then((m) => ({ default: m.MarkdownView })),
);
const HtmlPreview = lazy(() =>
  import("./HtmlPreview").then((m) => ({ default: m.HtmlPreview })),
);
const PdfViewer = lazy(() => import("./PdfViewer"));
const ImageViewer = lazy(() =>
  import("./ImageViewer").then((m) => ({ default: m.ImageViewer })),
);

function Welcome() {
  const mod = isMac() ? "⌘" : "Ctrl";
  return (
    <>
      <div className="tab-bar" role="tablist" aria-label="Open editors">
        <span>No open editors</span>
      </div>
      <div className="editor-welcome">
        <h1>Lyceum</h1>
        <p>A lightweight research IDE.</p>
        <ul className="welcome-hints">
          <li>
            <kbd>{mod}</kbd> + <kbd>B</kbd> Toggle sidebar
          </li>
          <li>
            <kbd>{mod}</kbd> + <kbd>J</kbd> Toggle panel
          </li>
          <li>
            <kbd>Ctrl</kbd> + <kbd>`</kbd> Toggle terminal
          </li>
        </ul>
      </div>
    </>
  );
}

export function EditorArea() {
  const hasDocs = useEditorStore((s) => s.docs.length > 0);
  const activePath = useEditorStore((s) => s.activePath);
  const activeKind = useEditorStore(
    (s) => s.docs.find((doc) => doc.path === s.activePath)?.kind ?? null,
  );
  const activeReloadVersion = useEditorStore(
    (s) =>
      s.docs.find((doc) => doc.path === s.activePath)?.reloadVersion ?? 0,
  );
  const hasTextDocs = useEditorStore((s) => s.docs.some(isTextDoc));
  const editorPreview = useLayoutStore((s) => s.editorPreview);
  const setEditorPreview = useLayoutStore((s) => s.setEditorPreview);
  // Preview replaces the editor view in place for supported text preview types.
  const showPreview =
    editorPreview &&
    activeKind === "text" &&
    !!activePath &&
    isInlinePreviewPath(activePath);
  const showPdf = activeKind === "pdf";
  const showImage = activeKind === "image";
  const previewLabel =
    activePath && isHtmlPath(activePath) ? "HTML preview" : "Markdown preview";

  function switchPreviewToSource(position?: MarkdownSourcePosition) {
    if (activePath && position) {
      useEditorStore
        .getState()
        .setPendingReveal(activePath, position.line, position.column);
    }
    setEditorPreview(false);
    window.setTimeout(() => getActiveEditor()?.focus(), 0);
  }

  // Hide the welcome screen when the editor column is too narrow to show it
  // (e.g. a right-docked terminal dragged wide) so it never paints clipped
  // fragments. 320px comfortably fits the title and the widest hint row.
  const areaRef = useRef<HTMLElement>(null);
  const [tooNarrowForWelcome, setTooNarrowForWelcome] = useState(false);
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setTooNarrowForWelcome(width > 0 && width < 320);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="editor-area" aria-label="Editor" ref={areaRef}>
      {hasDocs ? (
        <>
          <TabBar />
          <div className="editor-host-wrap">
            {/* Monaco stays mounted under the preview overlay so toggling back to
                the source keeps cursor/scroll/undo and avoids restarting LSP. */}
            {hasTextDocs && (
              <Suspense
                fallback={<div className="editor-loading">Loading editor…</div>}
              >
                <MonacoEditor />
              </Suspense>
            )}
            {showPreview && activePath && (
              <div className="editor-preview-overlay" aria-label={previewLabel}>
                <Suspense
                  fallback={<div className="editor-loading">Loading preview…</div>}
                >
                  {isMarkdownPath(activePath) ? (
                    <MarkdownView
                      key={activePath}
                      path={activePath}
                      onEditRequest={switchPreviewToSource}
                    />
                  ) : (
                    <HtmlPreview key={activePath} path={activePath} />
                  )}
                </Suspense>
              </div>
            )}
            {showPdf && activePath && (
              <div className="editor-preview-overlay" aria-label="PDF preview">
                <Suspense
                  fallback={<div className="editor-loading">Loading PDF…</div>}
                >
                  <PdfViewer
                    key={`${activePath}:${activeReloadVersion}`}
                    path={activePath}
                  />
                </Suspense>
              </div>
            )}
            {showImage && activePath && (
              <div className="editor-preview-overlay" aria-label="Image preview">
                <Suspense
                  fallback={<div className="editor-loading">Loading image…</div>}
                >
                  <ImageViewer
                    key={`${activePath}:${activeReloadVersion}`}
                    path={activePath}
                  />
                </Suspense>
              </div>
            )}
          </div>
        </>
      ) : tooNarrowForWelcome ? null : (
        <Welcome />
      )}
    </section>
  );
}
