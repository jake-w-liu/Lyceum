// File explorer tree (M2 + gap pass). Backed by `treeStore` (shared expansion +
// children cache) so it supports refresh / collapse-all / reveal, plus a toolbar
// and per-row actions for create / rename / delete. Directories load lazily.

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  createDirectory,
  createFile,
  movePaths,
  movePathsToTrash,
  readDirectory,
  redoTrashBatch,
  renamePath,
  restoreTrashBatch,
  type DirEntry,
} from "../lib/ipc";
import { useTreeStore } from "../state/treeStore";
import { useEditorStore } from "../state/editorStore";
import { useGitStore } from "../state/gitStore";
import {
  useContextMenuStore,
  type ContextMenuItem,
} from "../state/contextMenuStore";
import { commandRegistry } from "../commands/commandRegistry";
import { fileIconFor } from "../lib/fileIcons";
import { Icon } from "./Icon";

// Delay before a click on an already-selected file opens its inline rename.
// Long enough that a double-click (which opens the file) cancels it first.
const RENAME_CLICK_DELAY_MS = 400;

// VS Code-style single-letter badge for a changed file; folders show a dot.
function gitBadgeChar(status: string, isDir: boolean): string {
  if (isDir) return "●";
  switch (status) {
    case "modified":
      return "M";
    case "added":
      return "A";
    case "untracked":
      return "U";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "conflict":
      return "C";
    default:
      return "";
  }
}

function gitStatusLabel(status: string): string {
  switch (status) {
    case "modified":
      return "Modified";
    case "added":
      return "Added";
    case "untracked":
      return "Untracked";
    case "deleted":
      return "Deleted";
    case "renamed":
      return "Renamed";
    case "conflict":
      return "Conflict";
    default:
      return "";
  }
}

function parentDir(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx > 0 ? path.slice(0, idx) : path.slice(0, idx + 1);
}

// Join a parent directory and a child name without ever doubling the separator
// (e.g. a parent of "/" must yield "/name", not "//name").
function joinPath(parent: string, name: string): string {
  const sep = parent.includes("\\") ? "\\" : "/";
  return parent.endsWith(sep) ? `${parent}${name}` : `${parent}${sep}${name}`;
}

function pathSeparator(path: string): string {
  return path.includes("\\") ? "\\" : "/";
}

function isSameOrDescendant(path: string, parent: string): boolean {
  const sep = pathSeparator(parent);
  return path === parent || path.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

function isDirectChild(path: string, parent: string): boolean {
  return parentDir(path) === parent;
}

function isEditableEventTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function isSafeEntryName(name: string): boolean {
  return !!name && name !== "." && name !== ".." && !/[\\/]/.test(name);
}

function unsafeEntryNameMessage(name: string): string {
  return `Invalid name "${name}". Enter a single file or folder name, not a path.`;
}

function loadInto(path: string, refreshNonce = useTreeStore.getState().refreshNonce) {
  readDirectory(path)
    .then((entries) => {
      if (useTreeStore.getState().refreshNonce !== refreshNonce) return;
      useTreeStore.getState().setChildren(path, entries);
    })
    .catch(() => {
      if (useTreeStore.getState().refreshNonce !== refreshNonce) return;
      useTreeStore.getState().setChildren(path, []);
    });
}

function isRootDropSurface(
  target: EventTarget | null,
  currentTarget: HTMLElement,
): boolean {
  if (target === currentTarget) return true;
  return target instanceof HTMLElement && Boolean(target.closest(".tree-empty"));
}

interface VisibleEntry {
  entry: DirEntry;
  depth: number;
}

interface CreatingState {
  kind: "file" | "folder";
  parentPath: string;
}

function flattenVisibleEntries(
  entries: DirEntry[] | undefined,
  children: Record<string, DirEntry[]>,
  expanded: Record<string, boolean>,
  depth = 0,
): VisibleEntry[] {
  if (!entries) return [];
  const out: VisibleEntry[] = [];
  for (const entry of entries) {
    out.push({ entry, depth });
    if (entry.isDir && expanded[entry.path]) {
      out.push(
        ...flattenVisibleEntries(children[entry.path], children, expanded, depth + 1),
      );
    }
  }
  return out;
}

interface NodeProps {
  entry: DirEntry;
  depth: number;
  onOpenFile: (path: string) => void;
  onDeleteEntries: (entries: DirEntry[]) => void;
  onMoveEntries: (entries: DirEntry[], destinationDir: string) => void;
  creating: CreatingState | null;
  createInputRef: RefObject<HTMLInputElement | null>;
  onCommitCreate: (name: string) => void;
  selectedPaths: string[];
  visiblePaths: string[];
  selectedEntries: DirEntry[];
  draggingEntries: DirEntry[];
  setDraggingEntries: (entries: DirEntry[]) => void;
  dropTargetPath: string | null;
  setDropTargetPath: (path: string | null) => void;
}

function TreeNode({
  entry,
  depth,
  onOpenFile,
  onDeleteEntries,
  onMoveEntries,
  creating,
  createInputRef,
  onCommitCreate,
  selectedPaths,
  visiblePaths,
  selectedEntries,
  draggingEntries,
  setDraggingEntries,
  dropTargetPath,
  setDropTargetPath,
}: NodeProps) {
  const expanded = useTreeStore((s) => Boolean(s.expanded[entry.path]));
  const children = useTreeStore((s) => s.children[entry.path]);
  const refreshNonce = useTreeStore((s) => s.refreshNonce);
  const gitStatus = useGitStore((s) =>
    entry.isDir ? s.folders[entry.path] ?? null : s.files[entry.path] ?? null,
  );
  const [renaming, setRenaming] = useState(false);
  const selected = selectedPaths.includes(entry.path);
  // Pending VS Code-style "slow click" rename: a second click on an
  // already-selected file starts a timer; a double-click (open) cancels it.
  const renameClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearRenameClickTimer = () => {
    if (renameClickTimer.current) {
      clearTimeout(renameClickTimer.current);
      renameClickTimer.current = null;
    }
  };

  // (Re)load children when an expanded directory has no cached entries.
  useEffect(() => {
    if (entry.isDir && expanded && children === undefined) {
      loadInto(entry.path, refreshNonce);
    }
  }, [entry.isDir, entry.path, expanded, children, refreshNonce]);

  // Cancel a pending slow-click rename if this row stops being the sole
  // selection (e.g. the user clicked elsewhere before the timer fired), and on
  // unmount so the timer can't fire into a gone component.
  useEffect(() => {
    if (!selected) clearRenameClickTimer();
    return clearRenameClickTimer;
  }, [selected]);

  function onActivate(e: React.MouseEvent) {
    const tree = useTreeStore.getState();
    if (e.shiftKey) {
      clearRenameClickTimer();
      tree.selectRange(visiblePaths, entry.path);
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      clearRenameClickTimer();
      tree.toggleSelected(entry.path);
      return;
    }
    const wasSoleSelection =
      selected && selectedPaths.length === 1 && !entry.isDir;
    tree.selectSingle(entry.path);
    if (entry.isDir) {
      useTreeStore.getState().toggleExpanded(entry.path);
    } else if (wasSoleSelection) {
      // Click on an already-selected file → begin inline rename (like VS Code),
      // unless a double-click arrives first (handled in onDoubleClick → open).
      clearRenameClickTimer();
      renameClickTimer.current = setTimeout(() => {
        renameClickTimer.current = null;
        setRenaming(true);
      }, RENAME_CLICK_DELAY_MS);
    } else {
      onOpenFile(entry.path);
    }
  }

  function onRowKeyDown(e: React.KeyboardEvent) {
    // F2 renames the focused item (files and folders), matching VS Code.
    if (e.key === "F2") {
      e.preventDefault();
      clearRenameClickTimer();
      setRenaming(true);
    }
  }

  function onContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    clearRenameClickTimer();
    // Right-clicking a row outside the current selection selects just it, so the
    // menu's actions target what the user clicked (VS Code behavior).
    if (!selected) useTreeStore.getState().selectSingle(entry.path);
    const multi = selected && selectedPaths.length > 1;
    const run = (id: string) => () => void commandRegistry.execute(id);
    const items: ContextMenuItem[] = [
      { label: "New File", run: run("explorer.newFile") },
      { label: "New Folder", run: run("explorer.newFolder") },
      { label: "Rename", run: () => setRenaming(true), disabled: multi, separatorBefore: true },
      {
        label: multi ? `Delete ${selectedEntries.length} Items` : "Delete",
        run: () => onDeleteEntries(entriesForDelete()),
      },
      { label: "Copy Path", run: run("file.copyPath"), separatorBefore: true },
      { label: "Copy Relative Path", run: run("file.copyRelativePath") },
    ];
    useContextMenuStore.getState().openMenu(e.clientX, e.clientY, items);
  }

  function entriesForDelete(): DirEntry[] {
    return selected && selectedEntries.length > 1 ? selectedEntries : [entry];
  }

  function entriesForDrag(): DirEntry[] {
    return selected && selectedEntries.length > 1 ? selectedEntries : [entry];
  }

  function onDelete(e: React.MouseEvent) {
    e.stopPropagation();
    onDeleteEntries(entriesForDelete());
  }

  async function commitRename(name: string) {
    setRenaming(false);
    const trimmed = name.trim();
    if (!trimmed || trimmed === entry.name) return;
    if (!isSafeEntryName(trimmed)) {
      alert(unsafeEntryNameMessage(trimmed));
      return;
    }
    try {
      const to = joinPath(parentDir(entry.path), trimmed);
      await renamePath(entry.path, to);
      const move = [{ from: entry.path, to }];
      useEditorStore.getState().moveDocPaths(move);
      useTreeStore.getState().remapExpanded(move);
      useTreeStore.getState().setSelection([to]);
      useTreeStore.getState().refresh();
    } catch (err) {
      console.error("rename failed", err);
      // Re-sync the tree to disk and tell the user why (e.g. name already taken).
      useTreeStore.getState().refresh();
      alert(`Rename failed: ${String(err)}`);
    }
  }

  function canDropHere(): boolean {
    return entry.isDir && canMoveEntriesTo(draggingEntries, entry.path);
  }

  return (
    <li className="tree-node" role="none">
      <div
        className={
          "tree-row" +
          (selected ? " selected" : "") +
          (dropTargetPath === entry.path ? " drop-target" : "")
        }
        draggable={!renaming}
        style={{ paddingLeft: 8 + depth * 12 }}
        onContextMenu={onContextMenu}
        onDragStart={(e) => {
          const entries = entriesForDrag();
          if (!selected) useTreeStore.getState().selectSingle(entry.path);
          setDraggingEntries(entries);
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData(
            "application/x-lyceum-paths",
            JSON.stringify(entries.map((dragEntry) => dragEntry.path)),
          );
        }}
        onDragEnd={() => {
          setDraggingEntries([]);
          setDropTargetPath(null);
        }}
        onDragOver={(e) => {
          if (!canDropHere()) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "move";
          setDropTargetPath(entry.path);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          if (dropTargetPath === entry.path) setDropTargetPath(null);
        }}
        onDrop={(e) => {
          if (!canDropHere()) return;
          e.preventDefault();
          e.stopPropagation();
          setDropTargetPath(null);
          onMoveEntries(draggingEntries, entry.path);
        }}
      >
        <button
          type="button"
          role="treeitem"
          aria-selected={selected}
          className="tree-row-main"
          aria-expanded={entry.isDir ? expanded : undefined}
          title={
            gitStatus && !entry.isDir
              ? `${entry.name} — ${gitStatusLabel(gitStatus)}`
              : entry.name
          }
          onClick={onActivate}
          onDoubleClick={() => {
            // A double-click opens the file; cancel any pending slow-click rename.
            clearRenameClickTimer();
            if (!entry.isDir) onOpenFile(entry.path);
          }}
          onKeyDown={onRowKeyDown}
        >
          <span
            className={"tree-twisty" + (entry.isDir && expanded ? " expanded" : "")}
            aria-hidden="true"
          >
            {entry.isDir ? "▸" : ""}
          </span>
          <Icon
            name={
              entry.isDir
                ? expanded
                  ? "folder-open"
                  : "folder"
                : fileIconFor(entry.name)
            }
            size={14}
            className="tree-icon"
          />
          {renaming ? (
            <RenameInput initial={entry.name} onCommit={commitRename} />
          ) : (
            <span className={"tree-label" + (gitStatus ? ` git-${gitStatus}` : "")}>
              {entry.name}
            </span>
          )}
        </button>
        {!renaming && gitStatus && (
          <span className={`git-badge git-${gitStatus}`} aria-hidden="true">
            {gitBadgeChar(gitStatus, entry.isDir)}
          </span>
        )}
        {!renaming && (
          <span className="tree-actions">
            <button
              type="button"
              className="icon-button"
              aria-label={`Rename ${entry.name}`}
              onClick={(e) => {
                e.stopPropagation();
                setRenaming(true);
              }}
            >
              <Icon name="settings" size={12} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={`Delete ${entry.name}`}
              onClick={onDelete}
            >
              <Icon name="close" size={12} />
            </button>
          </span>
        )}
      </div>
      {entry.isDir &&
        expanded &&
        (children || creating?.parentPath === entry.path) && (
        <ul className="tree-children" role="group">
          {creating?.parentPath === entry.path && (
            <CreateInput
              creating={creating}
              depth={depth + 1}
              inputRef={createInputRef}
              onCommit={onCommitCreate}
            />
          )}
          {children?.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              onOpenFile={onOpenFile}
              onDeleteEntries={onDeleteEntries}
              onMoveEntries={onMoveEntries}
              creating={creating}
              createInputRef={createInputRef}
              onCommitCreate={onCommitCreate}
              selectedPaths={selectedPaths}
              visiblePaths={visiblePaths}
              selectedEntries={selectedEntries}
              draggingEntries={draggingEntries}
              setDraggingEntries={setDraggingEntries}
              dropTargetPath={dropTargetPath}
              setDropTargetPath={setDropTargetPath}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function canMoveEntriesTo(entries: DirEntry[], destinationDir: string): boolean {
  const movable = entries.filter((entry) => !isDirectChild(entry.path, destinationDir));
  return (
    movable.length > 0 &&
    movable.every(
      (entry) =>
        entry.path !== destinationDir &&
        !(entry.isDir && isSameOrDescendant(destinationDir, entry.path)),
    )
  );
}

function topLevelEntries(entries: DirEntry[]): DirEntry[] {
  const sorted = [...entries].sort(
    (a, b) => a.path.split(/[\\/]/).length - b.path.split(/[\\/]/).length,
  );
  const out: DirEntry[] = [];
  for (const entry of sorted) {
    if (!out.some((parent) => isSameOrDescendant(entry.path, parent.path))) {
      out.push(entry);
    }
  }
  return out;
}

function CreateInput({
  creating,
  depth,
  inputRef,
  onCommit,
}: {
  creating: CreatingState;
  depth: number;
  inputRef: RefObject<HTMLInputElement | null>;
  onCommit: (value: string) => void;
}) {
  return (
    <li className="tree-node" role="none">
      <div className="tree-row" style={{ paddingLeft: 20 + depth * 12 }}>
        <input
          ref={inputRef}
          className="tree-rename-input"
          // File names are literal: stop the WebView from auto-capitalizing the
          // first letter or autocorrecting/spell-checking the typed name.
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          aria-label={creating.kind === "folder" ? "New folder name" : "New file name"}
          placeholder={creating.kind === "folder" ? "folder name" : "file name"}
          onBlur={(e) => onCommit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCommit(e.currentTarget.value);
            else if (e.key === "Escape") onCommit("");
          }}
        />
      </div>
    </li>
  );
}

function RenameInput({
  initial,
  onCommit,
}: {
  initial: string;
  onCommit: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const committedRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  function commit(next: string) {
    if (committedRef.current) return;
    committedRef.current = true;
    onCommit(next);
  }
  // Focus and pre-select the base name (everything before the extension), like
  // VS Code — so typing replaces the name but keeps the extension by default.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const dot = initial.lastIndexOf(".");
    if (dot > 0) el.setSelectionRange(0, dot);
    else el.select();
  }, [initial]);
  return (
    <input
      ref={inputRef}
      className="tree-rename-input"
      aria-label="New name"
      // File names are literal: no auto-capitalization / autocorrect / spellcheck.
      autoCapitalize="off"
      autoCorrect="off"
      autoComplete="off"
      spellCheck={false}
      value={value}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => commit(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit(value);
        else if (e.key === "Escape") commit(initial);
      }}
    />
  );
}

export interface ExplorerProps {
  rootPath: string;
  onOpenFile: (path: string) => void;
}

export function Explorer({ rootPath, onOpenFile }: ExplorerProps) {
  const rootChildren = useTreeStore((s) => s.children[rootPath]);
  const allChildren = useTreeStore((s) => s.children);
  const expanded = useTreeStore((s) => s.expanded);
  const refreshNonce = useTreeStore((s) => s.refreshNonce);
  const selectedPaths = useTreeStore((s) => s.selectedPaths);
  const deleteUndoStack = useTreeStore((s) => s.deleteUndoStack);
  const deleteRedoStack = useTreeStore((s) => s.deleteRedoStack);
  const createRequest = useTreeStore((s) => s.createRequest);
  const [creating, setCreating] = useState<CreatingState | null>(null);
  const [draggingEntries, setDraggingEntries] = useState<DirEntry[]>([]);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const createInputRef = useRef<HTMLInputElement>(null);
  const createCommittedRef = useRef(false);
  const visibleEntries = useMemo(
    () => flattenVisibleEntries(rootChildren, allChildren, expanded),
    [rootChildren, allChildren, expanded],
  );
  const visiblePaths = useMemo(
    () => visibleEntries.map(({ entry }) => entry.path),
    [visibleEntries],
  );
  const selectedEntries = useMemo(
    () =>
      visibleEntries
        .map(({ entry }) => entry)
        .filter((entry) => selectedPaths.includes(entry.path)),
    [selectedPaths, visibleEntries],
  );

  useEffect(() => {
    if (rootChildren === undefined) loadInto(rootPath, refreshNonce);
  }, [rootPath, rootChildren, refreshNonce]);

  // Refresh git decorations on workspace open and after any tree mutation
  // (create/rename/delete/move all bump refreshNonce).
  useEffect(() => {
    void useGitStore.getState().refresh();
  }, [rootPath, refreshNonce]);

  // Refresh when the window regains focus (catches external edits, terminal
  // git commands, branch switches, etc.).
  useEffect(() => {
    const onFocus = () => void useGitStore.getState().refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Start the inline create flow when a global command (New File / New Folder /
  // Cmd+Ctrl+N) requests it, then clear the request so it fires exactly once.
  useEffect(() => {
    if (!createRequest) return;
    startCreate(createRequest);
    useTreeStore.getState().consumeCreateRequest();
    // startCreate is recreated each render but reads live state; the request is
    // consumed immediately so this can't double-fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createRequest]);

  function createParentPath(): string {
    if (selectedEntries.length !== 1) return rootPath;
    const selected = selectedEntries[0];
    return selected.isDir ? selected.path : parentDir(selected.path);
  }

  function startCreate(kind: "file" | "folder") {
    const parentPath = createParentPath();
    createCommittedRef.current = false;
    if (parentPath !== rootPath) {
      useTreeStore.getState().setExpanded(parentPath, true);
      if (useTreeStore.getState().children[parentPath] === undefined) {
        loadInto(parentPath);
      }
    }
    setCreating({ kind, parentPath });
    queueMicrotask(() => createInputRef.current?.focus());
  }

  async function commitCreate(name: string) {
    const pending = creating;
    if (createCommittedRef.current) return;
    createCommittedRef.current = true;
    setCreating(null);
    const trimmed = name.trim();
    if (!pending || !trimmed) return;
    if (!isSafeEntryName(trimmed)) {
      alert(unsafeEntryNameMessage(trimmed));
      return;
    }
    const target = joinPath(pending.parentPath, trimmed);
    try {
      if (pending.kind === "folder") await createDirectory(target);
      else await createFile(target);
      useTreeStore.getState().refresh();
    } catch (err) {
      console.error("create failed", err);
      // Surface duplicate-name / invalid-name failures instead of silently no-op.
      useTreeStore.getState().refresh();
      alert(`Create failed: ${String(err)}`);
    }
  }

  function closeDeletedDocs(paths: string[]) {
    const editor = useEditorStore.getState();
    for (const doc of editor.docs) {
      if (paths.some((path) => isSameOrDescendant(doc.path, path))) {
        useEditorStore.getState().closeDoc(doc.path);
      }
    }
  }

  async function deleteEntries(entries: DirEntry[]) {
    if (entries.length === 0) return;
    const names =
      entries.length === 1
        ? `"${entries[0].name}"`
        : `${entries.length} selected items`;
    if (!confirm(`Move ${names} to Lyceum Trash? You can undo this with Cmd/Ctrl+Z.`)) {
      return;
    }
    try {
      const batch = await movePathsToTrash(
        rootPath,
        entries.map((entry) => entry.path),
      );
      if (batch.items.length > 0) {
        useTreeStore.getState().recordDeleteBatch(batch);
        closeDeletedDocs(batch.items.map((item) => item.originalPath));
        useTreeStore
          .getState()
          .dropExpanded(batch.items.map((item) => item.originalPath));
      }
      useTreeStore.getState().clearSelection();
      useTreeStore.getState().refresh();
    } catch (err) {
      console.error("delete failed", err);
      // Re-sync after a possible partial trash move so the tree reflects disk.
      useTreeStore.getState().refresh();
      alert(`Delete failed: ${String(err)}`);
    }
  }

  async function undoDelete() {
    const tree = useTreeStore.getState();
    const batch = tree.popDeleteUndo();
    if (!batch) return;
    try {
      await restoreTrashBatch(rootPath, batch.items);
      tree.pushDeleteRedo(batch);
      tree.setSelection(batch.items.map((item) => item.originalPath));
      tree.refresh();
    } catch (err) {
      tree.pushDeleteUndo(batch);
      console.error("undo delete failed", err);
      alert(`Undo delete failed: ${String(err)}`);
    }
  }

  async function redoDelete() {
    const tree = useTreeStore.getState();
    const batch = tree.popDeleteRedo();
    if (!batch) return;
    try {
      await redoTrashBatch(rootPath, batch.items);
      tree.pushDeleteUndo(batch);
      closeDeletedDocs(batch.items.map((item) => item.originalPath));
      tree.clearSelection();
      tree.refresh();
    } catch (err) {
      tree.pushDeleteRedo(batch);
      console.error("redo delete failed", err);
      alert(`Redo delete failed: ${String(err)}`);
    }
  }

  async function moveEntries(entries: DirEntry[], destinationDir: string) {
    const movable = topLevelEntries(
      entries.filter((entry) => !isDirectChild(entry.path, destinationDir)),
    );
    if (!canMoveEntriesTo(movable, destinationDir)) return;
    try {
      const moved = await movePaths(
        rootPath,
        movable.map((entry) => entry.path),
        destinationDir,
      );
      if (moved.length > 0) {
        const localMoves = moved.map(({ from, to }) => ({ from, to }));
        useEditorStore.getState().moveDocPaths(localMoves);
        useTreeStore.getState().remapExpanded(localMoves);
        useTreeStore.getState().setSelection(localMoves.map((item) => item.to));
      }
      if (destinationDir !== rootPath) {
        useTreeStore.getState().setExpanded(destinationDir, true);
      }
      useTreeStore.getState().refresh();
    } catch (err) {
      console.error("move failed", err);
      // A move can fail partway (some entries already renamed on disk). Refresh
      // so the tree re-reads the real filesystem state instead of showing stale
      // paths for items that did move.
      useTreeStore.getState().refresh();
      alert(`Move failed: ${String(err)}`);
    }
  }

  function onExplorerKeyDown(e: React.KeyboardEvent) {
    if (isEditableEventTarget(e.target)) return;
    const key = e.key.toLowerCase();
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey && key === "z") {
      e.preventDefault();
      if (e.shiftKey) void redoDelete();
      else void undoDelete();
      return;
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && key === "y") {
      e.preventDefault();
      void redoDelete();
      return;
    }
    if (!mod && !e.altKey && (e.key === "Delete" || e.key === "Backspace")) {
      e.preventDefault();
      void deleteEntries(selectedEntries);
    }
  }

  return (
    <div className="explorer" tabIndex={0} onKeyDown={onExplorerKeyDown}>
      <div className="explorer-toolbar">
        <button
          type="button"
          className="icon-button"
          aria-label="New File"
          title="New File"
          onClick={() => startCreate("file")}
        >
          +
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="New Folder"
          title="New Folder"
          onClick={() => startCreate("folder")}
        >
          ▸+
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Refresh Explorer"
          title="Refresh"
          onClick={() => useTreeStore.getState().refresh()}
        >
          ⟳
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Collapse All"
          title="Collapse All"
          onClick={() => useTreeStore.getState().collapseAll()}
        >
          ⌄
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Delete Selected"
          title="Delete Selected"
          disabled={selectedEntries.length === 0}
          onClick={() => void deleteEntries(selectedEntries)}
        >
          <Icon name="close" size={12} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Undo Delete"
          title="Undo Delete"
          disabled={deleteUndoStack.length === 0}
          onClick={() => void undoDelete()}
        >
          <Icon name="undo" size={12} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Redo Delete"
          title="Redo Delete"
          disabled={deleteRedoStack.length === 0}
          onClick={() => void redoDelete()}
        >
          <Icon name="redo" size={12} />
        </button>
      </div>
      <ul
        className={"tree" + (dropTargetPath === rootPath ? " drop-target" : "")}
        role="tree"
        aria-label="Files"
        onDragOver={(e) => {
          if (!isRootDropSurface(e.target, e.currentTarget)) return;
          if (!canMoveEntriesTo(draggingEntries, rootPath)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setDropTargetPath(rootPath);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          if (dropTargetPath === rootPath) setDropTargetPath(null);
        }}
        onDrop={(e) => {
          if (!isRootDropSurface(e.target, e.currentTarget)) return;
          if (!canMoveEntriesTo(draggingEntries, rootPath)) return;
          e.preventDefault();
          setDropTargetPath(null);
          void moveEntries(draggingEntries, rootPath);
        }}
      >
        {creating?.parentPath === rootPath && (
          <CreateInput
            creating={creating}
            depth={0}
            inputRef={createInputRef}
            onCommit={commitCreate}
          />
        )}
        {rootChildren === undefined && <li className="tree-loading">Loading…</li>}
        {rootChildren !== undefined && rootChildren.length === 0 && !creating && (
          <li className="tree-empty">This folder is empty.</li>
        )}
        {rootChildren?.map((entry) => (
          <TreeNode
            key={entry.path}
            entry={entry}
            depth={0}
            onOpenFile={onOpenFile}
            onDeleteEntries={deleteEntries}
            onMoveEntries={moveEntries}
            creating={creating}
            createInputRef={createInputRef}
            onCommitCreate={commitCreate}
            selectedPaths={selectedPaths}
            visiblePaths={visiblePaths}
            selectedEntries={selectedEntries}
            draggingEntries={draggingEntries}
            setDraggingEntries={setDraggingEntries}
            dropTargetPath={dropTargetPath}
            setDropTargetPath={setDropTargetPath}
          />
        ))}
      </ul>
    </div>
  );
}
