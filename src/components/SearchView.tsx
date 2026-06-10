// Workspace search view (Cmd/Ctrl+Shift+F). Debounced content search over the
// open folder via the Rust `search_workspace` command; clicking a result (or
// ArrowUp/Down + Enter from the input, QuickOpen-style) opens the file at the
// match's line/column. Lives in the sidebar's "search" activity view.

import { useEffect, useRef, useState } from "react";
import { useSearchStore, type SearchMatch } from "../state/searchStore";
import { baseName, useWorkspaceStore } from "../state/workspaceStore";
import { searchWorkspace } from "../lib/ipc";

const SEARCH_DEBOUNCE_MS = 250;

export function SearchView() {
  const query = useSearchStore((s) => s.query);
  const results = useSearchStore((s) => s.results);
  const searching = useSearchStore((s) => s.searching);
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic request id: only the latest in-flight search may write state, so a
  // slow earlier response can't clobber newer results (out-of-order race).
  const seqRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const trimmed = query.trim();
    const seq = ++seqRef.current;
    setError(null);
    setActiveIndex(0);
    if (!rootPath || trimmed.length < 2) {
      // Invalidate any in-flight search so it can't later overwrite the cleared list.
      useSearchStore.getState().setResults([]);
      useSearchStore.getState().setSearching(false);
      return;
    }
    useSearchStore.getState().setResults([]);
    useSearchStore.getState().setSearching(false);
    timer.current = setTimeout(() => {
      if (seq !== seqRef.current) return;
      useSearchStore.getState().setSearching(true);
      searchWorkspace(rootPath, trimmed)
        .then((r) => {
          if (seq === seqRef.current) useSearchStore.getState().setResults(r);
        })
        .catch((e) => {
          if (seq === seqRef.current) {
            useSearchStore.getState().setResults([]);
            setError(String(e));
          }
        })
        .finally(() => {
          if (seq === seqRef.current) useSearchStore.getState().setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      seqRef.current += 1;
      useSearchStore.getState().setSearching(false);
    };
  }, [query, rootPath]);

  const openResult = (m: SearchMatch) =>
    useWorkspaceStore
      .getState()
      .requestOpenFile(m.path, { line: m.line, column: m.column });

  // QuickOpen-style keyboard navigation from the search input.
  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const m = results[activeIndex];
      if (m) openResult(m);
    }
  }

  const status = error
    ? `Search failed: ${error}`
    : searching
      ? "Searching…"
      : results.length > 0
        ? `${results.length} result${results.length === 1 ? "" : "s"}`
        : query.trim().length >= 2
          ? "No results"
          : "";

  return (
    <div className="search-view">
      <input
        className="search-input"
        aria-label="Search workspace"
        placeholder={rootPath ? "Search…" : "Open a folder to search"}
        value={query}
        autoFocus
        onChange={(e) => useSearchStore.getState().setQuery(e.target.value)}
        onKeyDown={onInputKeyDown}
      />
      <div className="search-status" role={error ? "alert" : undefined}>
        {status}
      </div>
      <ul className="search-results" role="listbox" aria-label="Search results">
        {results.map((m, i) => (
          <li
            key={`${m.path}:${m.line}:${m.column}:${i}`}
            className={"search-result" + (i === activeIndex ? " active" : "")}
            title={`${m.path}:${m.line}`}
            role="option"
            aria-selected={i === activeIndex}
            tabIndex={0}
            onMouseEnter={() => setActiveIndex(i)}
            onClick={() => openResult(m)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openResult(m);
              }
            }}
          >
            <span className="search-result-loc">
              {baseName(m.path)}:{m.line}
            </span>
            <span className="search-result-text">{m.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
