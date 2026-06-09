// The open-editors tab strip: one tab per open document, with an active
// indicator, an unsaved (dirty) dot, and a per-tab close button. Reads and
// drives editor state via useEditorStore.

import { Icon } from "./Icon";
import {
  isInlinePreviewPath,
  isJuliaSourcePath,
  isTexSourcePath,
} from "../lib/fileTypes";
import { runActiveJulia } from "../lib/julia";
import { runLatexBuild } from "../lib/latexBuild";
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

export function TabBar() {
  const docs = useEditorStore((s) => s.docs);
  const activePath = useEditorStore((s) => s.activePath);
  const setActive = useEditorStore((s) => s.setActive);
  const closeDoc = useEditorStore((s) => s.closeDoc);
  const editorPreview = useLayoutStore((s) => s.editorPreview);
  const toggleEditorPreview = useLayoutStore((s) => s.toggleEditorPreview);
  const outputRunning = useOutputStore((s) => s.running);

  const activeDoc = docs.find((d) => d.path === activePath);
  const canPreview = !!activeDoc && isInlinePreviewPath(activeDoc.path);
  const canLatexPreview =
    activeDoc?.kind === "text" && isTexSourcePath(activeDoc.path);
  const canJuliaRun =
    activeDoc?.kind === "text" && isJuliaSourcePath(activeDoc.path);
  const previewing = canPreview && editorPreview;

  function openTabMenu(e: React.MouseEvent, doc: EditorDoc) {
    e.preventDefault();
    const store = useEditorStore.getState();
    const items: ContextMenuItem[] = [
      {
        label: "Close",
        run: () => {
          if (confirmDiscard(doc.path)) store.closeDoc(doc.path);
        },
      },
      {
        label: "Close Others",
        run: () => store.closeOtherDocs(doc.path),
        separatorBefore: true,
      },
      { label: "Close to the Right", run: () => store.closeDocsToRight(doc.path) },
      { label: "Close Saved", run: () => store.closeSavedDocs() },
      { label: "Close All", run: () => store.closeAllDocs() },
    ];
    useContextMenuStore.getState().openMenu(e.clientX, e.clientY, items);
  }

  return (
    <div className="tab-bar">
      <div className="tab-list" role="tablist" aria-label="Open editors">
        {docs.map((doc) => {
          const active = doc.path === activePath;
          return (
            <div
              className={"tab" + (active ? " active" : "")}
              key={doc.path}
              onContextMenu={(e) => openTabMenu(e, doc)}
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
                onClick={() => {
                  if (confirmDiscard(doc.path)) closeDoc(doc.path);
                }}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          );
        })}
      </div>
      {canPreview && (
        <button
          type="button"
          className={"tab-action" + (previewing ? " active" : "")}
          aria-label={previewing ? "Show Source" : "Open Preview"}
          aria-pressed={previewing}
          title="Toggle Preview (⌘/Ctrl+Shift+V)"
          onClick={() => toggleEditorPreview()}
        >
          <Icon name={previewing ? "settings" : "preview"} size={14} />
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
      {!canPreview && !canLatexPreview && canJuliaRun && (
        <button
          type="button"
          className="tab-action"
          aria-label="Run Julia File or Selection"
          title="Run Julia File or Selection"
          disabled={outputRunning}
          onClick={() => void runActiveJulia()}
        >
          <Icon name="run" size={14} />
          <span>Run</span>
        </button>
      )}
    </div>
  );
}
