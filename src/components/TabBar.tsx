// The open-editors tab strip: one tab per open document, with an active
// indicator, an unsaved (dirty) dot, per-tab close buttons, and editor actions.
// Reads and drives editor state via useEditorStore.

import { useEffect, useRef } from "react";
import { Icon } from "./Icon";
import {
  isInlinePreviewPath,
  isTexSourcePath,
} from "../lib/fileTypes";
import { runActiveCode } from "../lib/codeRun";
import { runLatexBuild } from "../lib/latexBuild";
import { hasRunProfileForDoc } from "../lib/runProfiles";
import {
  confirmDiscard,
  isDirty,
  useEditorStore,
  type EditorDoc,
} from "../state/editorStore";
import { useLayoutStore } from "../state/layoutStore";
import { useOutputStore } from "../state/outputStore";
import {
  useContextMenuStore,
  type ContextMenuItem,
} from "../state/contextMenuStore";

function wheelDeltaToPixels(
  delta: number,
  deltaMode: number,
  viewportWidth: number,
): number {
  if (deltaMode === 1) return delta * 16;
  if (deltaMode === 2) return delta * viewportWidth;
  return delta;
}

export function TabBar() {
  const docs = useEditorStore((s) => s.docs);
  const activePath = useEditorStore((s) => s.activePath);
  const setActive = useEditorStore((s) => s.setActive);
  const closeDoc = useEditorStore((s) => s.closeDoc);
  const closeAllDocs = useEditorStore((s) => s.closeAllDocs);
  const editorPreview = useLayoutStore((s) => s.editorPreview);
  const toggleEditorPreview = useLayoutStore((s) => s.toggleEditorPreview);
  const outputRunning = useOutputStore((s) => s.running);

  const tabListRef = useRef<HTMLDivElement>(null);

  // Keep the active tab in view when activation happens off-screen (e.g. via
  // quick open or Ctrl+Tab) in an overflowing tab strip.
  useEffect(() => {
    if (!activePath) return;
    tabListRef.current
      ?.querySelector(".tab.active")
      ?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }, [activePath]);

  // Confirm-dirty-then-close shared by the close button, middle-click, and the
  // tab context menu. `confirmDiscard` is async (native dialog).
  async function closeWithConfirm(path: string) {
    if (await confirmDiscard(path)) closeDoc(path);
  }

  const activeDoc = docs.find((d) => d.path === activePath);
  const canPreview = !!activeDoc && isInlinePreviewPath(activeDoc.path);
  const canLatexPreview =
    activeDoc?.kind === "text" && isTexSourcePath(activeDoc.path);
  const canRun = hasRunProfileForDoc(activeDoc);
  const previewing = canPreview && editorPreview;

  function openTabMenu(e: React.MouseEvent, doc: EditorDoc) {
    e.preventDefault();
    const store = useEditorStore.getState();
    const items: ContextMenuItem[] = [
      {
        label: "Close",
        run: () => void closeWithConfirm(doc.path),
      },
      {
        label: "Close Others",
        run: () => void store.closeOtherDocs(doc.path),
        separatorBefore: true,
      },
      { label: "Close to the Right", run: () => void store.closeDocsToRight(doc.path) },
      { label: "Close Saved", run: () => void store.closeSavedDocs() },
      { label: "Close All", run: () => void store.closeAllDocs() },
    ];
    useContextMenuStore.getState().openMenu(e.clientX, e.clientY, items);
  }

  function onTabListWheel(e: React.WheelEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (el.scrollWidth <= el.clientWidth) return;

    const rawDelta =
      Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    const delta = wheelDeltaToPixels(rawDelta, e.deltaMode, el.clientWidth);
    if (delta === 0) return;

    const before = el.scrollLeft;
    el.scrollLeft += delta;
    if (el.scrollLeft !== before) e.preventDefault();
  }

  return (
    <div className="tab-bar">
      <div
        className="tab-list"
        role="tablist"
        aria-label="Open editors"
        ref={tabListRef}
        onWheel={onTabListWheel}
      >
        {docs.map((doc) => {
          const active = doc.path === activePath;
          return (
            <div
              className={"tab" + (active ? " active" : "")}
              key={doc.path}
              onContextMenu={(e) => openTabMenu(e, doc)}
              // Middle-click closes the tab (VS Code behavior), with the same
              // dirty-confirm path as the close button.
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  void closeWithConfirm(doc.path);
                }
              }}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className="tab-label"
                title={doc.path}
                onClick={() => setActive(doc.path)}
              >
                {isDirty(doc) && (
                  <span className="tab-dirty" aria-hidden="true">
                    ●
                  </span>
                )}
                <span className="tab-name">{doc.name}</span>
              </button>
              <button
                type="button"
                className="tab-close icon-button"
                aria-label={`Close ${doc.name}`}
                onClick={() => void closeWithConfirm(doc.path)}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="tab-actions" aria-label="Editor actions">
        {canPreview && (
          <button
            type="button"
            className={"tab-action" + (previewing ? " active" : "")}
            aria-label={previewing ? "Show Source" : "Open Preview"}
            aria-pressed={previewing}
            title="Toggle Preview (⌘/Ctrl+Shift+V)"
            onClick={() => toggleEditorPreview()}
          >
            <Icon name={previewing ? "edit" : "preview"} size={14} />
            <span>{previewing ? "Edit" : "Preview"}</span>
          </button>
        )}
        {!canPreview && canLatexPreview && activeDoc && (
          <>
            <button
              type="button"
              className="tab-action"
              aria-label="Compile LaTeX"
              title="Compile LaTeX"
              disabled={outputRunning}
              onClick={() =>
                void runLatexBuild({
                  targetPath: activeDoc.path,
                  openOnSuccess: false,
                })
              }
            >
              <Icon name="build" size={14} />
              <span>Compile</span>
            </button>
            <button
              type="button"
              className="tab-action"
              aria-label="Preview LaTeX PDF"
              title="Compile and Preview LaTeX PDF"
              disabled={outputRunning}
              onClick={() =>
                void runLatexBuild({
                  targetPath: activeDoc.path,
                  openOnSuccess: true,
                })
              }
            >
              <Icon name="preview" size={14} />
              <span>Preview</span>
            </button>
          </>
        )}
        {!canPreview && !canLatexPreview && canRun && (
          <button
            type="button"
            className="tab-action"
            aria-label="Run File or Selection"
            title="Run File or Selection"
            disabled={outputRunning}
            onClick={() => void runActiveCode()}
          >
            <Icon name="run" size={14} />
            <span>Run</span>
          </button>
        )}
        <button
          type="button"
          className="tab-close-all icon-button"
          aria-label="Close All Editors"
          title="Close All Editors"
          onClick={() => void closeAllDocs()}
        >
          <Icon name="close-all" size={15} />
        </button>
      </div>
    </div>
  );
}
