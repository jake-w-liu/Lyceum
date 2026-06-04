// File explorer tree (M2 + gap pass). Backed by `treeStore` (shared expansion +
// children cache) so it supports refresh / collapse-all / reveal, plus a toolbar
// and per-row actions for create / rename / delete. Directories load lazily.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createDirectory,
  createFile,
  movePathsToTrash,
  readDirectory,
  redoTrashBatch,
  renamePath,
  restoreTrashBatch,
  type DirEntry,
} from "../lib/ipc";
import { useTreeStore } from "../state/treeStore";
import { useEditorStore } from "../state/editorStore";
import { Icon } from "./Icon";

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

function isEditableEventTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function loadInto(path: string) {
  readDirectory(path)
    .then((entries) => useTreeStore.getState().setChildren(path, entries))
    .catch(() => useTreeStore.getState().setChildren(path, []));
}

interface VisibleEntry {
  entry: DirEntry;
  depth: number;
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
  selectedPaths: string[];
  visiblePaths: string[];
  selectedEntries: DirEntry[];
}

function TreeNode({
  entry,
  depth,
  onOpenFile,
  onDeleteEntries,
  selectedPaths,
  visiblePaths,
  selectedEntries,
}: NodeProps) {
  const expanded = useTreeStore((s) => Boolean(s.expanded[entry.path]));
  const children = useTreeStore((s) => s.children[entry.path]);
  const refreshNonce = useTreeStore((s) => s.refreshNonce);
  const [renaming, setRenaming] = useState(false);
  const selected = selectedPaths.includes(entry.path);

  // (Re)load children when an expanded directory has no cached entries.
  useEffect(() => {
    if (entry.isDir && expanded && children === undefined) loadInto(entry.path);
  }, [entry.isDir, entry.path, expanded, children, refreshNonce]);

  function onActivate(e: React.MouseEvent) {
    const tree = useTreeStore.getState();
    if (e.shiftKey) {
      tree.selectRange(visiblePaths, entry.path);
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      tree.toggleSelected(entry.path);
      return;
    }
    tree.selectSingle(entry.path);
    if (entry.isDir) useTreeStore.getState().toggleExpanded(entry.path);
    else onOpenFile(entry.path);
  }

  function entriesForDelete(): DirEntry[] {
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
    try {
      await renamePath(entry.path, joinPath(parentDir(entry.path), trimmed));
      useTreeStore.getState().refresh();
    } catch (err) {
      console.error("rename failed", err);
    }
  }

  return (
    <li className="tree-node" role="none">
      <div
        className={"tree-row" + (selected ? " selected" : "")}
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <button
          type="button"
          role="treeitem"
          aria-selected={selected}
          className="tree-row-main"
          aria-expanded={entry.isDir ? expanded : undefined}
          title={entry.name}
          onClick={onActivate}
        >
          <span
            className={"tree-twisty" + (entry.isDir && expanded ? " expanded" : "")}
            aria-hidden="true"
          >
            {entry.isDir ? "▸" : ""}
          </span>
          {renaming ? (
            <RenameInput initial={entry.name} onCommit={commitRename} />
          ) : (
            <span className="tree-label">{entry.name}</span>
          )}
        </button>
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
      {entry.isDir && expanded && children && (
        <ul className="tree-children" role="group">
          {children.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              onOpenFile={onOpenFile}
              onDeleteEntries={onDeleteEntries}
              selectedPaths={selectedPaths}
              visiblePaths={visiblePaths}
              selectedEntries={selectedEntries}
            />
          ))}
        </ul>
      )}
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
  return (
    <input
      className="tree-rename-input"
      aria-label="New name"
      autoFocus
      value={value}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(value);
        else if (e.key === "Escape") onCommit(initial);
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
  const [creating, setCreating] = useState<null | "file" | "folder">(null);
  const createInputRef = useRef<HTMLInputElement>(null);
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
    if (rootChildren === undefined) loadInto(rootPath);
  }, [rootPath, rootChildren, refreshNonce]);

  async function commitCreate(name: string) {
    const kind = creating;
    setCreating(null);
    const trimmed = name.trim();
    if (!kind || !trimmed) return;
    const target = joinPath(rootPath, trimmed);
    try {
      if (kind === "folder") await createDirectory(target);
      else await createFile(target);
      useTreeStore.getState().refresh();
    } catch (err) {
      console.error("create failed", err);
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
      }
      useTreeStore.getState().clearSelection();
      useTreeStore.getState().refresh();
    } catch (err) {
      console.error("delete failed", err);
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
          onClick={() => {
            setCreating("file");
            queueMicrotask(() => createInputRef.current?.focus());
          }}
        >
          +
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="New Folder"
          title="New Folder"
          onClick={() => {
            setCreating("folder");
            queueMicrotask(() => createInputRef.current?.focus());
          }}
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
      <ul className="tree" role="tree" aria-label="Files">
        {creating && (
          <li className="tree-node" role="none">
            <div className="tree-row" style={{ paddingLeft: 20 }}>
              <input
                ref={createInputRef}
                className="tree-rename-input"
                aria-label={creating === "folder" ? "New folder name" : "New file name"}
                placeholder={creating === "folder" ? "folder name" : "file name"}
                onBlur={(e) => commitCreate(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitCreate(e.currentTarget.value);
                  else if (e.key === "Escape") setCreating(null);
                }}
              />
            </div>
          </li>
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
            selectedPaths={selectedPaths}
            visiblePaths={visiblePaths}
            selectedEntries={selectedEntries}
          />
        ))}
      </ul>
    </div>
  );
}
