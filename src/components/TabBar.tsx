// The open-editors tab strip: one tab per open document, with an active
// indicator, an unsaved (dirty) dot, and a per-tab close button. Reads and
// drives editor state via useEditorStore.

import { Icon } from "./Icon";
import { isDirty, useEditorStore } from "../state/editorStore";

export function TabBar() {
  const docs = useEditorStore((s) => s.docs);
  const activePath = useEditorStore((s) => s.activePath);
  const setActive = useEditorStore((s) => s.setActive);
  const closeDoc = useEditorStore((s) => s.closeDoc);

  return (
    <div className="tab-bar" role="tablist" aria-label="Open editors">
      {docs.map((doc) => {
        const active = doc.path === activePath;
        return (
          <div className={"tab" + (active ? " active" : "")} key={doc.path}>
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
              onClick={() => closeDoc(doc.path)}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
