// Command palette overlay (mod+shift+P): fuzzy-search and run registered
// commands. Visible only while the UI store's active modal is "palette".
//
// With no query, results are grouped by category (browsing mode); with a query,
// results are the flat best-match order. Each row shows its bound keybinding.

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useUiStore } from "../state/uiStore";
import { commandRegistry } from "../commands/commandRegistry";
import { useKeymapStore } from "../state/keymapStore";
import { formatChord } from "../keybindings/keybindingRegistry";
import { isMac } from "../hooks/useLayoutKeybindings";
import { fuzzyFilter } from "../lib/fuzzy";

export function CommandPalette() {
  const activeModal = useUiStore((s) => s.activeModal);
  const closeModal = useUiStore((s) => s.closeModal);
  const keymap = useKeymapStore((s) => s.keymap);

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  // Reset the search each time the palette opens so a stale query from a prior
  // session doesn't linger (the component stays mounted while hidden).
  useEffect(() => {
    if (activeModal === "palette") {
      setQuery("");
      setSelected(0);
    }
  }, [activeModal]);

  // Last binding wins (user overrides are appended after defaults), matching the
  // keymap matcher; shown as a hint next to each command.
  const keyByCommand = useMemo(() => {
    const map = new Map<string, string>();
    for (const binding of keymap) map.set(binding.command, binding.key);
    return map;
  }, [keymap]);

  const grouped = query.trim() === "";

  // Memoized; only computed while the palette is open (commandRegistry.list()
  // is not hoisted above the gate so it doesn't run on every closed-state render).
  const results = useMemo(() => {
    if (activeModal !== "palette") return [];
    const all = commandRegistry.list();
    if (grouped) {
      // Group by category (alphabetical), preserving registration order within
      // each group via a stable sort.
      return [...all].sort((a, b) =>
        (a.category ?? "").localeCompare(b.category ?? ""),
      );
    }
    return fuzzyFilter(all, query, (c) => c.title);
  }, [activeModal, query, grouped]);

  // Keep the keyboard-selected row visible as ArrowUp/ArrowDown move it past
  // the list's scroll fold. `nearest` is a no-op when it's already in view.
  useEffect(() => {
    listRef.current
      ?.querySelector(".modal-item.selected")
      ?.scrollIntoView?.({ block: "nearest" });
  }, [selected, results]);

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

  const macOs = isMac();

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
        <ul className="modal-list" role="listbox" ref={listRef}>
          {results.map((cmd, i) => {
            const showHeader =
              grouped && (i === 0 || results[i - 1].category !== cmd.category);
            const chord = keyByCommand.get(cmd.id);
            return (
              <Fragment key={cmd.id}>
                {showHeader && (
                  <li className="modal-category-header" role="presentation">
                    {cmd.category ?? "Other"}
                  </li>
                )}
                <li
                  role="option"
                  aria-selected={i === selected}
                  className={"modal-item" + (i === selected ? " selected" : "")}
                  onClick={() => runAt(i)}
                >
                  <span className="modal-item-title">{cmd.title}</span>
                  {chord && (
                    <span className="modal-item-detail">
                      {formatChord(chord, macOs)}
                    </span>
                  )}
                </li>
              </Fragment>
            );
          })}
          {results.length === 0 && (
            <li className="modal-empty">No matching commands</li>
          )}
        </ul>
      </div>
    </div>
  );
}
