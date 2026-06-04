// Command palette overlay (mod+shift+P): fuzzy-search and run registered
// commands. Visible only while the UI store's active modal is "palette".

import { useEffect, useMemo, useState } from "react";
import { useUiStore } from "../state/uiStore";
import { commandRegistry } from "../commands/commandRegistry";
import { fuzzyFilter } from "../lib/fuzzy";

export function CommandPalette() {
  const activeModal = useUiStore((s) => s.activeModal);
  const closeModal = useUiStore((s) => s.closeModal);

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  // Memoized; only computed while the palette is open (commandRegistry.list()
  // is not hoisted above the gate so it doesn't run on every closed-state render).
  const results = useMemo(
    () =>
      activeModal === "palette"
        ? fuzzyFilter(commandRegistry.list(), query, (c) => c.title)
        : [],
    [activeModal, query],
  );

  if (activeModal !== "palette") {
    return null;
  }

  function runAt(i: number) {
    const cmd = results[i];
    if (cmd) {
      closeModal();
      void commandRegistry.execute(cmd.id);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      // Clamp to 0 when empty so ArrowDown can't leave selected at -1 (matches QuickOpen).
      setSelected((s) => Math.min(s + 1, Math.max(results.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAt(selected);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeModal();
    }
  }

  return (
    <div className="modal-overlay" onClick={closeModal}>
      <div
        className="modal"
        role="dialog"
        aria-label="Command Palette"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          className="modal-input"
          autoFocus
          placeholder="Type a command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Command input"
        />
        <ul className="modal-list" role="listbox">
          {results.map((cmd, i) => (
            <li
              key={cmd.id}
              role="option"
              aria-selected={i === selected}
              className={"modal-item" + (i === selected ? " selected" : "")}
              onClick={() => runAt(i)}
            >
              {cmd.title}
            </li>
          ))}
          {results.length === 0 && (
            <li className="modal-empty">No matching commands</li>
          )}
        </ul>
      </div>
    </div>
  );
}
