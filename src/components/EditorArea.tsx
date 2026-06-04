// Main editor area. With documents open it shows the tab strip and the
// lazily-loaded Monaco editor; with none open it shows the welcome screen with
// the layout-toggle keyboard hints.

import { Suspense, lazy } from "react";
import { isMac } from "../hooks/useLayoutKeybindings";
import { useEditorStore } from "../state/editorStore";
import { useLayoutStore } from "../state/layoutStore";
import { TabBar } from "./TabBar";

const MARKDOWN_RE = /\.(md|markdown)$/i;

// Lazy so the Monaco bundle + workers load only once a document is opened.
const MonacoEditor = lazy(() => import("./MonacoEditor"));
const MarkdownView = lazy(() =>
  import("./MarkdownView").then((m) => ({ default: m.MarkdownView })),
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
        <p>A lightweight, VS Code-inspired research IDE.</p>
        <ul className="welcome-hints">
          <li>
            <kbd>{mod}</kbd> + <kbd>B</kbd> Toggle sidebar
          </li>
          <li>
            <kbd>{mod}</kbd> + <kbd>J</kbd> Toggle panel
          </li>
          <li>
            <kbd>{mod}</kbd> + <kbd>`</kbd> Toggle terminal
          </li>
        </ul>
      </div>
    </>
  );
}

export function EditorArea() {
  const hasDocs = useEditorStore((s) => s.docs.length > 0);
  const activePath = useEditorStore((s) => s.activePath);
  const editorPreview = useLayoutStore((s) => s.editorPreview);
  // Preview replaces the editor view in place — only for the active Markdown doc.
  const showPreview =
    editorPreview && !!activePath && MARKDOWN_RE.test(activePath);

  return (
    <section className="editor-area" aria-label="Editor">
      {hasDocs ? (
        <>
          <TabBar />
          <div className="editor-host-wrap">
            {/* Monaco stays mounted under the preview overlay so toggling back to
                the source keeps cursor/scroll/undo and avoids restarting LSP. */}
            <Suspense
              fallback={<div className="editor-loading">Loading editor…</div>}
            >
              <MonacoEditor />
            </Suspense>
            {showPreview && activePath && (
              <div className="editor-preview-overlay" aria-label="Markdown preview">
                <Suspense
                  fallback={<div className="editor-loading">Loading preview…</div>}
                >
                  <MarkdownView key={activePath} path={activePath} />
                </Suspense>
              </div>
            )}
          </div>
        </>
      ) : (
        <Welcome />
      )}
    </section>
  );
}
