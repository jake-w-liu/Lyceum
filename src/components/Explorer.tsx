// File explorer tree (M2 + gap pass). Backed by `treeStore` (shared expansion +
// children cache) so it supports refresh / collapse-all / reveal, plus a toolbar
// and per-row actions for create / rename / delete. Directories load lazily.

import { useEffect, useRef, useState } from "react";
import {
  createDirectory,
  createFile,
  deletePath,
  readDirectory,
  renamePath,
  type DirEntry,
} from "../lib/ipc";
import { useTreeStore } from "../state/treeStore";
import { useEditorStore } from "../state/editorStore";
import { Icon } from "./Icon";

function parentDir(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx > 0 ? path.slice(0, idx) : path.slice(0, idx + 1);
}

function loadInto(path: string) {
  readDirectory(path)
    .then((entries) => useTreeStore.getState().setChildren(path, entries))
    .catch(() => useTreeStore.getState().setChildren(path, []));
}

interface NodeProps {
  entry: DirEntry;
  depth: number;
  onOpenFile: (path: string) => void;
}

function TreeNode({ entry, depth, onOpenFile }: NodeProps) {
  const expanded = useTreeStore((s) => Boolean(s.expanded[entry.path]));
  const children = useTreeStore((s) => s.children[entry.path]);
  const refreshNonce = useTreeStore((s) => s.refreshNonce);
  const [renaming, setRenaming] = useState(false);

  // (Re)load children when an expanded directory has no cached entries.
  useEffect(() => {
    if (entry.isDir && expanded && children === undefined) loadInto(entry.path);
  }, [entry.isDir, entry.path, expanded, children, refreshNonce]);

  function onActivate() {
    if (entry.isDir) useTreeStore.getState().toggleExpanded(entry.path);
    else onOpenFile(entry.path);
  }

  async function onDelete(e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm(`Delete "${entry.name}"? This cannot be undone.`)) return;
    try {
      await deletePath(entry.path);
      useEditorStore.getState().closeDoc(entry.path);
      useTreeStore.getState().refresh();
    } catch (err) {
      console.error("delete failed", err);
    }
  }

  async function commitRename(name: string) {
    setRenaming(false);
    const trimmed = name.trim();
    if (!trimmed || trimmed === entry.name) return;
    try {
      await renamePath(entry.path, `${parentDir(entry.path)}/${trimmed}`);
      useTreeStore.getState().refresh();
    } catch (err) {
      console.error("rename failed", err);
    }
  }

  return (
    <li className="tree-node" role="none">
      <div className="tree-row" style={{ paddingLeft: 8 + depth * 12 }}>
        <button
          type="button"
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
  const refreshNonce = useTreeStore((s) => s.refreshNonce);
  const [creating, setCreating] = useState<null | "file" | "folder">(null);
  const createInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (rootChildren === undefined) loadInto(rootPath);
  }, [rootPath, rootChildren, refreshNonce]);

  async function commitCreate(name: string) {
    const kind = creating;
    setCreating(null);
    const trimmed = name.trim();
    if (!kind || !trimmed) return;
    const target = `${rootPath}/${trimmed}`;
    try {
      if (kind === "folder") await createDirectory(target);
      else await createFile(target);
      useTreeStore.getState().refresh();
    } catch (err) {
      console.error("create failed", err);
    }
  }

  return (
    <div className="explorer">
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
          />
        ))}
      </ul>
    </div>
  );
}
