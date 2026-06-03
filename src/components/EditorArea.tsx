// Main editor area. With documents open it shows the tab strip and the
// lazily-loaded Monaco editor; with none open it shows the welcome screen with
// the layout-toggle keyboard hints.

import { Suspense, lazy } from "react";
import { isMac } from "../hooks/useLayoutKeybindings";
import { useEditorStore } from "../state/editorStore";
import { TabBar } from "./TabBar";

// Lazy so the Monaco bundle + workers load only once a document is opened.
const MonacoEditor = lazy(() => import("./MonacoEditor"));

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
  return (
    <section className="editor-area" aria-label="Editor">
      {hasDocs ? (
        <>
          <TabBar />
          <div className="editor-host-wrap">
            <Suspense
              fallback={<div className="editor-loading">Loading editor…</div>}
            >
              <MonacoEditor />
            </Suspense>
          </div>
        </>
      ) : (
        <Welcome />
      )}
    </section>
  );
}
