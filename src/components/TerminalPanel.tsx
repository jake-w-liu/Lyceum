// Terminal panel (M5): tab strip for multiple terminals plus the active
// terminal view. Auto-creates a terminal on first mount. Each session's
// TerminalView stays mounted (hidden when inactive) so switching tabs does not
// kill its shell; closing a tab or the panel closes its PTY.

import { useEffect, useState } from "react";
import { useTerminalStore } from "../state/terminalStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import { TerminalView } from "./TerminalView";
import { Icon } from "./Icon";

export function TerminalPanel() {
  const terminals = useTerminalStore((s) => s.terminals);
  const activeId = useTerminalStore((s) => s.activeId);
  const createTerminal = useTerminalStore((s) => s.createTerminal);
  const closeTerminal = useTerminalStore((s) => s.closeTerminal);
  const setActive = useTerminalStore((s) => s.setActive);
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  useEffect(() => {
    if (useTerminalStore.getState().terminals.length === 0) {
      createTerminal(rootPath);
    }
  }, [createTerminal, rootPath]);

  return (
    <div className="terminal-panel">
      <div className="terminal-tabs" role="tablist" aria-label="Terminals">
        {terminals.map((t) => (
          <div
            key={t.id}
            className={"terminal-tab" + (t.id === activeId ? " active" : "")}
          >
            {renamingId === t.id ? (
              <input
                className="terminal-rename-input"
                aria-label="Rename terminal"
                autoFocus
                defaultValue={t.title}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  if (e.target.value.trim())
                    useTerminalStore.getState().renameTerminal(t.id, e.target.value.trim());
                  setRenamingId(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const v = e.currentTarget.value.trim();
                    if (v) useTerminalStore.getState().renameTerminal(t.id, v);
                    setRenamingId(null);
                  } else if (e.key === "Escape") setRenamingId(null);
                }}
              />
            ) : (
              <button
                type="button"
                role="tab"
                aria-selected={t.id === activeId}
                className="terminal-tab-label"
                onClick={() => setActive(t.id)}
                onDoubleClick={() => setRenamingId(t.id)}
                title="Double-click to rename"
              >
                {t.title}
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              aria-label={`Close ${t.title}`}
              onClick={() => closeTerminal(t.id)}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="icon-button terminal-new"
          aria-label="New Terminal"
          title="New Terminal"
          onClick={() => createTerminal(rootPath)}
        >
          +
        </button>
      </div>
      <div className="terminal-views">
        {terminals.map((t) => (
          <div
            key={t.id}
            className="terminal-view-host"
            style={{ display: t.id === activeId ? "block" : "none" }}
          >
            <TerminalView
              id={t.id}
              cwd={t.cwd}
              active={t.id === activeId}
              startupCommand={t.startupCommand}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export default TerminalPanel;
