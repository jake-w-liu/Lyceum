// Quick-open file finder (mod+P): fuzzy-search workspace files by name and
// open the chosen one. Visible only while useUiStore.activeModal === "quickOpen".

import { useEffect, useMemo, useState } from "react";
import { useUiStore } from "../state/uiStore";
import { baseName, useWorkspaceStore } from "../state/workspaceStore";
import { listWorkspaceFiles } from "../lib/ipc";
import { fuzzyFilter } from "../lib/fuzzy";

const MAX_RESULTS = 100;

export function QuickOpen() {
  const activeModal = useUiStore((s) => s.activeModal);
  const closeModal = useUiStore((s) => s.closeModal);
  const rootPath = useWorkspaceStore((s) => s.rootPath);

  const [files, setFiles] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    if (activeModal !== "quickOpen") {
      return;
    }
    setQuery("");
    setSelected(0);
    if (!rootPath) {
      setFiles([]);
      return;
    }
    let cancelled = false;
    listWorkspaceFiles(rootPath)
      .then((paths) => {
        if (!cancelled) {
          setFiles(paths);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFiles([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeModal, rootPath]);

  // Memoized + capped so it doesn't re-filter all paths on hover/selection
  // re-renders, and never runs while the modal is closed.
  const results = useMemo(
    () =>
      activeModal === "quickOpen"
        ? fuzzyFilter(files, query, (p) => p).slice(0, MAX_RESULTS)
        : [],
    [activeModal, files, query],
  );

  if (activeModal !== "quickOpen") {
    return null;
  }

  function openAt(i: number) {
    const path = results[i];
    if (path) {
      closeModal();
      useWorkspaceStore.getState().requestOpenFile(path);
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      openAt(selected);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeModal();
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal" role="dialog" aria-label="Quick Open">
        <input
          className="modal-input"
          aria-label="File search"
          placeholder="Search files by name…"
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
        />
        <ul className="modal-list">
          {!rootPath ? (
            <li className="modal-empty">Open a folder first</li>
          ) : results.length === 0 ? (
            <li className="modal-empty">No matching files</li>
          ) : (
            results.map((path, i) => (
              <li
                key={path}
                className={"modal-item" + (i === selected ? " active" : "")}
                title={path}
                onMouseEnter={() => setSelected(i)}
                onClick={() => openAt(i)}
              >
                {baseName(path)}
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
