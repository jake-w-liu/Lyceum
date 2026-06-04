// Workspace search view (Cmd/Ctrl+Shift+F). Debounced content search over the
// open folder via the Rust `search_workspace` command; clicking a result opens
// the file. Lives in the sidebar's "search" activity view.

import { useEffect, useRef } from "react";
import { useSearchStore } from "../state/searchStore";
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

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const trimmed = query.trim();
    if (!rootPath || trimmed.length < 2) {
      // Invalidate any in-flight search so it can't later overwrite the cleared list.
      seqRef.current++;
      useSearchStore.getState().setResults([]);
      return;
    }
    timer.current = setTimeout(() => {
      const seq = ++seqRef.current;
      useSearchStore.getState().setSearching(true);
      searchWorkspace(rootPath, trimmed)
        .then((r) => {
          if (seq === seqRef.current) useSearchStore.getState().setResults(r);
        })
        .catch(() => {
          if (seq === seqRef.current) useSearchStore.getState().setResults([]);
        })
        .finally(() => {
          if (seq === seqRef.current) useSearchStore.getState().setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, rootPath]);

  const status = searching
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
      />
      <div className="search-status">{status}</div>
      <ul className="search-results">
        {results.map((m, i) => (
          <li
            key={`${m.path}:${m.line}:${m.column}:${i}`}
            className="search-result"
            title={`${m.path}:${m.line}`}
            onClick={() => useWorkspaceStore.getState().requestOpenFile(m.path)}
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
