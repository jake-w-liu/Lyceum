// Quick-open file finder (mod+P): fuzzy-search workspace files by name and
// open the chosen one. Visible only while useUiStore.activeModal === "quickOpen".

import { useEffect, useMemo, useRef, useState } from "react";
import { useUiStore } from "../state/uiStore";
import { baseName, useWorkspaceStore } from "../state/workspaceStore";
import { useTreeStore } from "../state/treeStore";
import { listWorkspaceFiles } from "../lib/ipc";
import { fuzzyFilter } from "../lib/fuzzy";

const MAX_RESULTS = 100;

// The directory shown after a result's file name (VS Code style), relative to
// the workspace root so duplicates like `a/index.ts` / `b/index.ts` are
// distinguishable. Empty for files directly in the root.
function relativeDir(path: string, rootPath: string | null): string {
  const sep = path.includes("\\") ? "\\" : "/";
  let rel = path;
  if (rootPath) {
    const prefix = rootPath.endsWith(sep) ? rootPath : rootPath + sep;
    if (path.startsWith(prefix)) rel = path.slice(prefix.length);
  }
  const idx = rel.lastIndexOf(sep);
  return idx > 0 ? rel.slice(0, idx) : "";
}

export function QuickOpen() {
  const activeModal = useUiStore((s) => s.activeModal);
  const closeModal = useUiStore((s) => s.closeModal);
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const refreshNonce = useTreeStore((s) => s.refreshNonce);

  const [files, setFiles] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (activeModal !== "quickOpen") {
      return;
    }
    setQuery("");
    setSelected(0);
  }, [activeModal]);

  useEffect(() => {
    if (activeModal !== "quickOpen") {
      return;
    }
    if (!rootPath) {
      setFiles([]);
      return;
    }
    let cancelled = false;
    setFiles([]);
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
  }, [activeModal, rootPath, refreshNonce]);

  // Memoized + capped so it doesn't re-filter all paths on hover/selection
  // re-renders, and never runs while the modal is closed.
  const results = useMemo(
    () =>
      activeModal === "quickOpen"
        ? fuzzyFilter(files, query, (p) => p).slice(0, MAX_RESULTS)
        : [],
    [activeModal, files, query],
  );

  // Keep the keyboard-selected row visible as ArrowUp/ArrowDown move it past
  // the list's scroll fold. `nearest` is a no-op when it's already in view.
  useEffect(() => {
    listRef.current
      ?.querySelector(".modal-item.selected")
      ?.scrollIntoView?.({ block: "nearest" });
  }, [selected, results]);

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
    <div className="modal-overlay" onClick={closeModal}>
      <div
        className="modal"
        role="dialog"
        aria-label="Quick Open"
        onClick={(e) => e.stopPropagation()}
      >
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
        <ul className="modal-list" ref={listRef}>
          {!rootPath ? (
            <li className="modal-empty">Open a folder first</li>
          ) : results.length === 0 ? (
            <li className="modal-empty">No matching files</li>
          ) : (
            results.map((path, i) => {
              const dir = relativeDir(path, rootPath);
              return (
                <li
                  key={path}
                  className={"modal-item" + (i === selected ? " selected" : "")}
                  title={path}
                  // onMouseMove (not onMouseEnter): keyboard ArrowUp/Down scrolls
                  // a row under a stationary cursor, which fires mouseenter and
                  // would hijack the keyboard selection so Enter opens the wrong
                  // file. mousemove fires only on real pointer movement.
                  onMouseMove={() => setSelected(i)}
                  onClick={() => openAt(i)}
                >
                  <span className="modal-item-name">{baseName(path)}</span>
                  {dir && <span className="modal-item-dir">{dir}</span>}
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}
