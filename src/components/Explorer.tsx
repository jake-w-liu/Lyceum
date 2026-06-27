// File explorer tree (M2 + gap pass). Backed by `treeStore` (shared expansion +
// children cache) so it supports refresh / collapse-all / reveal, plus a toolbar
// and per-row actions for create / rename / delete. Directories load lazily.

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  copyPaths,
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
import { confirmDiscard, useEditorStore } from "../state/editorStore";
import { useGitStore, type GitScope } from "../state/gitStore";
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

function gitStatusLabel(status: string, scope: GitScope = "workspace"): string {
  const prefix = scope === "nested" ? "Nested repo " : "";
  switch (status) {
    case "modified":
      return `${prefix}Modified`;
    case "added":
      return `${prefix}Added`;
    case "untracked":
      return `${prefix}Untracked`;
    case "deleted":
      return `${prefix}Deleted`;
    case "renamed":
      return `${prefix}Renamed`;
    case "conflict":
      return `${prefix}Conflict`;
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

function dragPathsFromDataTransfer(dataTransfer: DataTransfer): string[] {
  try {
    const raw = dataTransfer.getData("application/x-lyceum-paths");
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((path): path is string => typeof path === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Native yes/no confirmation via the dialog plugin (same pattern as
 * editorStore's askDiscard): `window.confirm` is unreliable in Tauri WebViews,
 * so use the plugin and fall back to `confirm` only outside Tauri (vite dev,
 * tests), where the plugin rejects.
 */
async function confirmDelete(text: string): Promise<boolean> {
  try {
    return await ask(text, { title: "Delete", kind: "warning" });
  } catch {
    return confirm(text);
  }
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
  return (
    target instanceof HTMLElement &&
    Boolean(target.closest(".tree-empty, .tree-root-drop-spacer"))
  );
}

interface VisibleEntry {
  entry: DirEntry;
  depth: number;
}

interface CreatingState {
  kind: "file" | "folder";
  parentPath: string;
}

interface ExplorerClipboard {
  operation: "copy" | "cut";
  entries: DirEntry[];
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
  resolveDraggingEntries: (dataTransfer: DataTransfer) => DirEntry[];
  onDragFinished: (dataTransfer: DataTransfer) => void;
  clipboard: ExplorerClipboard | null;
  onCopyEntries: (entries: DirEntry[]) => void;
  onCutEntries: (entries: DirEntry[]) => void;
  onPasteInto: (destinationDir: string) => void;
  canPasteInto: (destinationDir: string) => boolean;
  dropTargetPath: string | null;
  setDropTargetPath: (path: string | null) => void;
  /** Ask the Explorer to focus a row (once it exists after a refresh). */
  onRequestFocus: (path: string) => void;
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
  resolveDraggingEntries,
  onDragFinished,
  clipboard,
  onCopyEntries,
  onCutEntries,
  onPasteInto,
  canPasteInto,
  dropTargetPath,
  setDropTargetPath,
  onRequestFocus,
}: NodeProps) {
  const expanded = useTreeStore((s) => Boolean(s.expanded[entry.path]));
  const children = useTreeStore((s) => s.children[entry.path]);
  const loadedAtNonce = useTreeStore((s) => s.loadedAtNonce[entry.path]);
  const refreshNonce = useTreeStore((s) => s.refreshNonce);
  const gitStatus = useGitStore((s) =>
    entry.isDir ? s.folders[entry.path] ?? null : s.files[entry.path] ?? null,
  );
  const gitScope = useGitStore((s) =>
    entry.isDir
      ? s.folderScopes[entry.path] ?? "workspace"
      : s.fileScopes[entry.path] ?? "workspace",
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

  // (Re)load children when an expanded directory has no cached entries, or when
  // a refresh marked the cached listing stale. Keep stale rows visible until
  // the replacement listing arrives to avoid a flash.
  useEffect(() => {
    if (entry.isDir && expanded && loadedAtNonce !== refreshNonce) {
      loadInto(entry.path, refreshNonce);
    }
  }, [entry.isDir, entry.path, expanded, loadedAtNonce, refreshNonce]);

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
    } else {
      // A single click on a file always opens it (VS Code behavior). When the
      // file was already the sole selection, additionally arm the slow-click
      // rename; a double-click (open) cancels it before it fires.
      onOpenFile(entry.path);
      if (wasSoleSelection) {
        clearRenameClickTimer();
        renameClickTimer.current = setTimeout(() => {
          renameClickTimer.current = null;
          setRenaming(true);
        }, RENAME_CLICK_DELAY_MS);
      }
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
      {
        label: multi ? `Copy ${selectedEntries.length} Items` : "Copy",
        run: () => onCopyEntries(entriesForOperation()),
        separatorBefore: true,
      },
      {
        label: multi ? `Cut ${selectedEntries.length} Items` : "Cut",
        run: () => onCutEntries(entriesForOperation()),
      },
      {
        label: "Paste",
        run: () => onPasteInto(pasteDestinationDir()),
        disabled: !clipboard || !canPasteHere(),
      },
      {
        label: "Rename",
        run: () => setRenaming(true),
        disabled: multi,
        separatorBefore: true,
      },
      {
        label: multi ? `Delete ${selectedEntries.length} Items` : "Delete",
        run: () => onDeleteEntries(entriesForOperation()),
      },
      { label: "Copy Path", run: run("file.copyPath"), separatorBefore: true },
      { label: "Copy Relative Path", run: run("file.copyRelativePath") },
    ];
    useContextMenuStore.getState().openMenu(e.clientX, e.clientY, items);
  }

  function entriesForOperation(): DirEntry[] {
    return selected && selectedEntries.length > 1 ? selectedEntries : [entry];
  }

  function entriesForDrag(): DirEntry[] {
    return entriesForOperation();
  }

  function pasteDestinationDir(): string {
    return entry.isDir ? entry.path : parentDir(entry.path);
  }

  function canPasteHere(): boolean {
    return canPasteInto(pasteDestinationDir());
  }

  function onDelete(e: React.MouseEvent) {
    e.stopPropagation();
    onDeleteEntries(entriesForOperation());
  }

  async function commitRename(name: string) {
    setRenaming(false);
    const trimmed = name.trim();
    if (!trimmed || trimmed === entry.name) {
      // Cancelled / no-op rename: put focus back on the row so F2 etc. keep
      // working (the rename input had stolen it).
      onRequestFocus(entry.path);
      return;
    }
    if (!isSafeEntryName(trimmed)) {
      onRequestFocus(entry.path);
      void message(unsafeEntryNameMessage(trimmed));
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
      // Refocus the renamed row once the refreshed tree contains it.
      onRequestFocus(to);
    } catch (err) {
      console.error("rename failed", err);
      // Re-sync the tree to disk and tell the user why (e.g. name already taken).
      useTreeStore.getState().refresh();
      onRequestFocus(entry.path);
      void message(`Rename failed: ${String(err)}`);
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
        onDragEnd={(e) => {
          onDragFinished(e.dataTransfer);
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
          const entries = resolveDraggingEntries(e.dataTransfer);
          if (!entry.isDir || !canMoveEntriesTo(entries, entry.path)) return;
          e.preventDefault();
          e.stopPropagation();
          setDropTargetPath(null);
          onMoveEntries(entries, entry.path);
        }}
      >
        <button
          type="button"
          role="treeitem"
          aria-selected={selected}
          className="tree-row-main"
          data-path={entry.path}
          data-isdir={entry.isDir ? "1" : ""}
          aria-expanded={entry.isDir ? expanded : undefined}
          title={
            gitStatus
              ? `${entry.name} — ${gitStatusLabel(gitStatus, gitScope)}`
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
            <span
              className={
                "tree-label" +
                (gitStatus ? ` git-${gitStatus} git-scope-${gitScope}` : "")
              }
            >
              {entry.name}
            </span>
          )}
        </button>
        {!renaming && gitStatus && (
          <span
            className={`git-badge git-${gitStatus} git-scope-${gitScope}`}
            aria-hidden="true"
          >
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
              <Icon name="edit" size={12} />
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
              resolveDraggingEntries={resolveDraggingEntries}
              onDragFinished={onDragFinished}
              clipboard={clipboard}
              onCopyEntries={onCopyEntries}
              onCutEntries={onCutEntries}
              onPasteInto={onPasteInto}
              canPasteInto={canPasteInto}
              dropTargetPath={dropTargetPath}
              setDropTargetPath={setDropTargetPath}
              onRequestFocus={onRequestFocus}
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

function canCopyEntriesTo(entries: DirEntry[], destinationDir: string): boolean {
  return (
    entries.length > 0 &&
    entries.every(
      (entry) =>
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
  const rootLoadedAtNonce = useTreeStore((s) => s.loadedAtNonce[rootPath]);
  const allChildren = useTreeStore((s) => s.children);
  const expanded = useTreeStore((s) => s.expanded);
  const refreshNonce = useTreeStore((s) => s.refreshNonce);
  const selectedPaths = useTreeStore((s) => s.selectedPaths);
  const deleteUndoStack = useTreeStore((s) => s.deleteUndoStack);
  const deleteRedoStack = useTreeStore((s) => s.deleteRedoStack);
  const createRequest = useTreeStore((s) => s.createRequest);
  const [creating, setCreating] = useState<CreatingState | null>(null);
  const [draggingEntries, setDraggingEntries] = useState<DirEntry[]>([]);
  const [clipboard, setClipboard] = useState<ExplorerClipboard | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const dragDropCommittedRef = useRef(false);
  const [pendingFocusPath, setPendingFocusPath] = useState<string | null>(null);
  const createInputRef = useRef<HTMLInputElement>(null);
  const createCommittedRef = useRef(false);
  const treeRef = useRef<HTMLUListElement>(null);
  const explorerRef = useRef<HTMLDivElement>(null);
  const visibleEntries = useMemo(
    () => flattenVisibleEntries(rootChildren, allChildren, expanded),
    [rootChildren, allChildren, expanded],
  );
  const visiblePaths = useMemo(
    () => visibleEntries.map(({ entry }) => entry.path),
    [visibleEntries],
  );
  const entryByPath = useMemo(() => {
    const map = new Map<string, DirEntry>();
    for (const { entry } of visibleEntries) map.set(entry.path, entry);
    return map;
  }, [visibleEntries]);
  // Resolve the selection through the FULL loaded tree (not just visible rows) so
  // delete/move/create act on every selected path even when an ancestor folder
  // was collapsed (e.g. Collapse All) AFTER the items were selected. A
  // visible-only projection would silently skip hidden-but-selected items.
  const allEntryByPath = useMemo(() => {
    const map = new Map<string, DirEntry>();
    for (const children of Object.values(allChildren)) {
      for (const entry of children) map.set(entry.path, entry);
    }
    return map;
  }, [allChildren]);
  const resolvedSelectedEntries = useMemo(
    () =>
      selectedPaths
        .map((path) => allEntryByPath.get(path))
        .filter((entry): entry is DirEntry => entry !== undefined),
    [selectedPaths, allEntryByPath],
  );

  // Focus (and reveal) a row by path. Returns false when the row isn't in the
  // DOM yet (e.g. right after a refresh).
  function focusRow(path: string): boolean {
    const el = treeRef.current?.querySelector<HTMLElement>(
      `[data-path="${CSS.escape(path)}"]`,
    );
    if (!el) return false;
    el.focus();
    el.scrollIntoView?.({ block: "nearest" });
    return true;
  }

  // Deferred focus restoration: rename/delete trigger a tree refresh, so the
  // target row may not exist until the refreshed children arrive. Retry on
  // visible-entries changes, but with a bounded life: never steal focus from
  // an inline rename/create input the user opened while the refresh was in
  // flight (focusing the row would blur and commit/cancel it), and give up
  // after the entries change a couple of times without the row appearing.
  const pendingFocusDeadlineRef = useRef(0);
  function requestRowFocus(path: string) {
    // Time budget rather than a per-change count: one tree mutation bumps the
    // refresh nonce for EVERY expanded directory, and each completing reload
    // changes visibleEntries. A miss-count budget was consumed by those
    // unrelated sibling reloads before the target row's own listing arrived,
    // silently dropping keyboard focus to <body>. A deadline keeps retrying
    // until the row appears or the window elapses.
    pendingFocusDeadlineRef.current = Date.now() + 1500;
    setPendingFocusPath(path);
  }
  useEffect(() => {
    if (!pendingFocusPath) return;
    if (isEditableEventTarget(document.activeElement)) {
      setPendingFocusPath(null);
      return;
    }
    if (focusRow(pendingFocusPath)) {
      setPendingFocusPath(null);
      return;
    }
    // Not in the DOM yet — keep the request alive across completing reloads
    // (each changes visibleEntries and re-runs this effect) until the deadline.
    // The deadline also prevents a late, unexpected focus steal.
    if (Date.now() > pendingFocusDeadlineRef.current) setPendingFocusPath(null);
    // focusRow only reads refs/DOM; visibleEntries drives the retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFocusPath, visibleEntries]);

  useEffect(() => {
    if (rootLoadedAtNonce !== refreshNonce) loadInto(rootPath, refreshNonce);
  }, [rootPath, rootLoadedAtNonce, refreshNonce]);

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
    // Resolve through the FULL tree (like delete/move) so New File/New Folder
    // still target the selected directory when an ancestor was collapsed (e.g.
    // Collapse All) after selection — the visible-only selectedEntries would be
    // empty and wrongly create the item at the workspace root.
    if (resolvedSelectedEntries.length !== 1) return rootPath;
    const selected = resolvedSelectedEntries[0];
    return selected.isDir ? selected.path : parentDir(selected.path);
  }

  function startCreate(kind: "file" | "folder") {
    const parentPath = createParentPath();
    createCommittedRef.current = false;
    if (parentPath !== rootPath) {
      // Expand the WHOLE ancestor chain from the root down to parentPath, not just
      // parentPath itself. createParentPath resolves through the full tree, so the
      // target can sit under a collapsed ancestor (e.g. after Collapse All); if any
      // intervening ancestor stays collapsed, parentPath's TreeNode — and the inline
      // create input — never renders and New File/New Folder silently no-ops with a
      // stuck `creating` state. Mirror revealActiveFile's ancestor walk.
      const sep = rootPath.includes("\\") ? "\\" : "/";
      const rel = parentPath.slice(rootPath.length).replace(/^[/\\]/, "");
      const ancestors = [rootPath];
      let cur = rootPath;
      for (const segment of rel.split(/[/\\]/)) {
        cur = `${cur}${sep}${segment}`;
        ancestors.push(cur);
      }
      useTreeStore.getState().expandPaths(ancestors);
      const cached = useTreeStore.getState().children;
      for (const ancestor of ancestors) {
        if (cached[ancestor] === undefined) loadInto(ancestor);
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
      void message(unsafeEntryNameMessage(trimmed));
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
      void message(`Create failed: ${String(err)}`);
    }
  }

  async function closeDeletedDocs(paths: string[]) {
    const docsToClose = useEditorStore
      .getState()
      .docs.filter((doc) =>
        paths.some((path) => isSameOrDescendant(doc.path, path)),
      )
      .map((doc) => doc.path);
    for (const path of docsToClose) {
      if (await confirmDiscard(path)) {
        useEditorStore.getState().closeDoc(path);
      }
    }
  }

  // The nearest visible row that survives deleting `deleted` (next below the
  // first deleted row, else nearest above), for focus restoration.
  function nearestSurvivor(deleted: string[]): string | null {
    const gone = (path: string) =>
      deleted.some((d) => isSameOrDescendant(path, d));
    const first = visiblePaths.findIndex(gone);
    if (first === -1) return null;
    for (let i = first; i < visiblePaths.length; i += 1) {
      if (!gone(visiblePaths[i])) return visiblePaths[i];
    }
    for (let i = first - 1; i >= 0; i -= 1) {
      if (!gone(visiblePaths[i])) return visiblePaths[i];
    }
    return null;
  }

  async function deleteEntries(entries: DirEntry[]) {
    if (entries.length === 0) return;
    const names =
      entries.length === 1
        ? `"${entries[0].name}"`
        : `${entries.length} selected items`;
    const confirmed = await confirmDelete(
      `Move ${names} to Lyceum Trash? You can undo this with Cmd/Ctrl+Z.`,
    );
    if (!confirmed) return;
    const survivor = nearestSurvivor(entries.map((entry) => entry.path));
    try {
      const batch = await movePathsToTrash(
        rootPath,
        entries.map((entry) => entry.path),
      );
      if (batch.items.length > 0) {
        useTreeStore.getState().recordDeleteBatch(batch);
        useTreeStore
          .getState()
          .dropExpanded(batch.items.map((item) => item.originalPath));
        // Deletion already completed; keep the tree refresh/focus path
        // synchronous and let dirty-tab discard prompts resolve separately.
        void closeDeletedDocs(batch.items.map((item) => item.originalPath));
      }
      // Keep keyboard flows alive after the rows vanish: select + focus the
      // nearest surviving sibling, or fall back to the tree container.
      if (survivor) {
        useTreeStore.getState().setSelection([survivor]);
        requestRowFocus(survivor);
      } else {
        useTreeStore.getState().clearSelection();
        treeRef.current?.focus();
      }
      useTreeStore.getState().refresh();
    } catch (err) {
      console.error("delete failed", err);
      // Re-sync after a possible partial trash move so the tree reflects disk.
      useTreeStore.getState().refresh();
      void message(`Delete failed: ${String(err)}`);
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
      void message(`Undo delete failed: ${String(err)}`);
    }
  }

  async function redoDelete() {
    const tree = useTreeStore.getState();
    const batch = tree.popDeleteRedo();
    if (!batch) return;
    try {
      await redoTrashBatch(rootPath, batch.items);
      tree.pushDeleteUndo(batch);
      tree.clearSelection();
      tree.refresh();
      // Redo should refresh the tree immediately even if a dirty tab needs a
      // discard confirmation before it can close.
      void closeDeletedDocs(batch.items.map((item) => item.originalPath));
    } catch (err) {
      tree.pushDeleteRedo(batch);
      console.error("redo delete failed", err);
      void message(`Redo delete failed: ${String(err)}`);
    }
  }

  async function moveEntries(
    entries: DirEntry[],
    destinationDir: string,
  ): Promise<boolean> {
    const movable = topLevelEntries(
      entries.filter((entry) => !isDirectChild(entry.path, destinationDir)),
    );
    if (!canMoveEntriesTo(movable, destinationDir)) return false;
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
      return moved.length > 0;
    } catch (err) {
      console.error("move failed", err);
      // A move can fail partway (some entries already renamed on disk). Refresh
      // so the tree re-reads the real filesystem state instead of showing stale
      // paths for items that did move.
      useTreeStore.getState().refresh();
      void message(`Move failed: ${String(err)}`);
      return false;
    }
  }

  function copyEntriesToExplorerClipboard(entries: DirEntry[]) {
    const copied = topLevelEntries(entries);
    if (copied.length > 0) setClipboard({ operation: "copy", entries: copied });
  }

  function cutEntriesToExplorerClipboard(entries: DirEntry[]) {
    const cut = topLevelEntries(entries);
    if (cut.length > 0) setClipboard({ operation: "cut", entries: cut });
  }

  function resolveDraggingEntries(dataTransfer: DataTransfer): DirEntry[] {
    if (draggingEntries.length > 0) return draggingEntries;
    return topLevelEntries(
      dragPathsFromDataTransfer(dataTransfer)
        .map((path) => allEntryByPath.get(path))
        .filter((entry): entry is DirEntry => entry !== undefined),
    );
  }

  function commitDragMove(
    dataTransfer: DataTransfer,
    destinationDir: string | null,
  ) {
    if (!destinationDir || dragDropCommittedRef.current) return;
    const entries = resolveDraggingEntries(dataTransfer);
    if (!canMoveEntriesTo(entries, destinationDir)) return;
    dragDropCommittedRef.current = true;
    setDropTargetPath(null);
    void moveEntries(entries, destinationDir);
  }

  function finishDrag(dataTransfer: DataTransfer) {
    commitDragMove(dataTransfer, dropTargetPath);
    window.setTimeout(() => {
      dragDropCommittedRef.current = false;
      setDraggingEntries([]);
      setDropTargetPath(null);
    }, 0);
  }

  function canPasteInto(destinationDir: string): boolean {
    if (!clipboard) return false;
    return clipboard.operation === "copy"
      ? canCopyEntriesTo(clipboard.entries, destinationDir)
      : canMoveEntriesTo(clipboard.entries, destinationDir);
  }

  function selectedPasteDestination(): string {
    if (resolvedSelectedEntries.length !== 1) return rootPath;
    const selected = resolvedSelectedEntries[0];
    return selected.isDir ? selected.path : parentDir(selected.path);
  }

  async function pasteInto(destinationDir: string) {
    const pending = clipboard;
    if (!pending) return;
    if (pending.operation === "cut") {
      const moved = await moveEntries(pending.entries, destinationDir);
      if (moved) setClipboard(null);
      return;
    }
    if (!canCopyEntriesTo(pending.entries, destinationDir)) return;
    try {
      const copied = await copyPaths(
        rootPath,
        pending.entries.map((entry) => entry.path),
        destinationDir,
      );
      if (destinationDir !== rootPath) {
        useTreeStore.getState().setExpanded(destinationDir, true);
      }
      if (copied.length > 0) {
        useTreeStore.getState().setSelection(copied.map((item) => item.to));
      }
      useTreeStore.getState().refresh();
    } catch (err) {
      console.error("paste failed", err);
      useTreeStore.getState().refresh();
      void message(`Paste failed: ${String(err)}`);
    }
  }

  function openRootContextMenu(e: React.MouseEvent) {
    if (!isRootDropSurface(e.target, e.currentTarget as HTMLElement)) return;
    e.preventDefault();
    e.stopPropagation();
    const startRootCreate = (kind: "file" | "folder") => {
      useTreeStore.getState().clearSelection();
      startCreate(kind);
    };
    const items: ContextMenuItem[] = [
      { label: "New File", run: () => startRootCreate("file") },
      { label: "New Folder", run: () => startRootCreate("folder") },
      {
        label: "Paste",
        run: () => void pasteInto(rootPath),
        disabled: !canPasteInto(rootPath),
        separatorBefore: true,
      },
    ];
    useContextMenuStore.getState().openMenu(e.clientX, e.clientY, items);
  }

  // Copy OS files dropped into the explorer (from Finder etc.) into the folder
  // under the cursor — VS Code-style import.
  async function importPaths(sourcePaths: string[], destinationDir: string) {
    if (sourcePaths.length === 0) return;
    try {
      const copied = await copyPaths(rootPath, sourcePaths, destinationDir);
      if (destinationDir !== rootPath) {
        useTreeStore.getState().setExpanded(destinationDir, true);
      }
      if (copied.length > 0) {
        useTreeStore.getState().setSelection(copied.map((item) => item.to));
      }
      useTreeStore.getState().refresh();
    } catch (err) {
      console.error("import failed", err);
      void message(`Import failed: ${String(err)}`);
    }
  }

  // Tauri intercepts native file drops, so the destination folder is resolved by
  // hit-testing the DOM under the (physical-pixel) cursor rather than via web
  // dragover events. Returns null when the cursor is outside the explorer.
  function resolveImportDir(position: { x: number; y: number }): string | null {
    const dpr = window.devicePixelRatio || 1;
    const el = document.elementFromPoint(position.x / dpr, position.y / dpr);
    if (!el || !explorerRef.current?.contains(el)) return null;
    const row = el.closest<HTMLElement>("[data-path]");
    if (!row) return rootPath; // inside the explorer but not on a row → root
    const path = row.dataset.path!;
    return row.dataset.isdir === "1" ? path : parentDir(path);
  }

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    let webview;
    try {
      webview = getCurrentWebview();
    } catch {
      // Not running inside a Tauri webview (e.g. unit tests) — file-drop import
      // simply isn't wired; the explorer still renders and works normally.
      return;
    }
    void webview
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "drop") {
          setDropTargetPath(null);
          const dir = resolveImportDir(payload.position);
          if (dir) void importPaths(payload.paths, dir);
        } else if (payload.type === "enter" || payload.type === "over") {
          setDropTargetPath(resolveImportDir(payload.position));
        } else {
          setDropTargetPath(null); // leave
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
    // resolveImportDir/importPaths close over rootPath; re-subscribe when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath]);

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
    if (mod && !e.altKey && !e.shiftKey && key === "c") {
      if (resolvedSelectedEntries.length > 0) {
        e.preventDefault();
        copyEntriesToExplorerClipboard(resolvedSelectedEntries);
      }
      return;
    }
    if (mod && !e.altKey && !e.shiftKey && key === "x") {
      if (resolvedSelectedEntries.length > 0) {
        e.preventDefault();
        cutEntriesToExplorerClipboard(resolvedSelectedEntries);
      }
      return;
    }
    if (mod && !e.altKey && !e.shiftKey && key === "v") {
      if (clipboard) {
        e.preventDefault();
        void pasteInto(selectedPasteDestination());
      }
      return;
    }
    if (!mod && !e.altKey && (e.key === "Delete" || e.key === "Backspace")) {
      e.preventDefault();
      void deleteEntries(resolvedSelectedEntries);
    }
  }

  // Arrow-key navigation for the tree (role="tree"), VS Code style:
  // Up/Down move through visible rows, Right expands / enters a dir, Left
  // collapses / moves to the parent, Enter opens a file or toggles a dir,
  // Home/End jump. Selection uses the existing single-selection mechanism.
  function onTreeKeyDown(e: React.KeyboardEvent) {
    if (isEditableEventTarget(e.target)) return;
    const navKeys = [
      "ArrowDown",
      "ArrowUp",
      "ArrowRight",
      "ArrowLeft",
      "Enter",
      "Home",
      "End",
    ];
    if (!navKeys.includes(e.key) || visiblePaths.length === 0) return;
    const rowPath =
      e.target instanceof HTMLElement
        ? e.target.closest<HTMLElement>("[data-path]")?.dataset.path ?? null
        : null;
    // Let Enter activate non-row controls inside the tree (the per-row
    // rename/delete buttons); rows and the tree itself are handled below.
    if (e.key === "Enter" && !rowPath && e.target !== e.currentTarget) return;
    e.preventDefault();
    e.stopPropagation();
    const tree = useTreeStore.getState();
    const current =
      rowPath && visiblePaths.includes(rowPath)
        ? rowPath
        : selectedPaths.find((path) => visiblePaths.includes(path)) ?? null;
    const index = current ? visiblePaths.indexOf(current) : -1;
    const moveTo = (path: string | undefined) => {
      if (!path) return;
      tree.selectSingle(path);
      focusRow(path);
    };
    switch (e.key) {
      case "ArrowDown":
        moveTo(visiblePaths[index < 0 ? 0 : Math.min(index + 1, visiblePaths.length - 1)]);
        break;
      case "ArrowUp":
        moveTo(visiblePaths[index < 0 ? 0 : Math.max(index - 1, 0)]);
        break;
      case "Home":
        moveTo(visiblePaths[0]);
        break;
      case "End":
        moveTo(visiblePaths[visiblePaths.length - 1]);
        break;
      case "ArrowRight": {
        if (!current) {
          moveTo(visiblePaths[0]);
          break;
        }
        const entry = entryByPath.get(current);
        if (!entry?.isDir) break;
        if (!expanded[current]) {
          tree.setExpanded(current, true);
        } else {
          const next = visiblePaths[index + 1];
          if (next && isDirectChild(next, current)) moveTo(next);
        }
        break;
      }
      case "ArrowLeft": {
        if (!current) {
          moveTo(visiblePaths[0]);
          break;
        }
        const entry = entryByPath.get(current);
        if (entry?.isDir && expanded[current]) {
          tree.setExpanded(current, false);
        } else {
          const parent = parentDir(current);
          if (visiblePaths.includes(parent)) moveTo(parent);
        }
        break;
      }
      case "Enter": {
        if (!current) break;
        const entry = entryByPath.get(current);
        if (!entry) break;
        if (entry.isDir) tree.toggleExpanded(current);
        else onOpenFile(current);
        break;
      }
    }
  }

  return (
    <div
      className="explorer"
      tabIndex={0}
      ref={explorerRef}
      onKeyDown={onExplorerKeyDown}
    >
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
          disabled={resolvedSelectedEntries.length === 0}
          onClick={() => void deleteEntries(resolvedSelectedEntries)}
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
        ref={treeRef}
        tabIndex={-1}
        onKeyDown={onTreeKeyDown}
        onContextMenu={openRootContextMenu}
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
          const entries = resolveDraggingEntries(e.dataTransfer);
          if (!isRootDropSurface(e.target, e.currentTarget)) return;
          if (!canMoveEntriesTo(entries, rootPath)) return;
          e.preventDefault();
          dragDropCommittedRef.current = true;
          setDropTargetPath(null);
          void moveEntries(entries, rootPath);
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
            selectedEntries={resolvedSelectedEntries}
            draggingEntries={draggingEntries}
            setDraggingEntries={setDraggingEntries}
            resolveDraggingEntries={resolveDraggingEntries}
            onDragFinished={finishDrag}
            clipboard={clipboard}
            onCopyEntries={copyEntriesToExplorerClipboard}
            onCutEntries={cutEntriesToExplorerClipboard}
            onPasteInto={(destinationDir) => void pasteInto(destinationDir)}
            canPasteInto={canPasteInto}
            dropTargetPath={dropTargetPath}
            setDropTargetPath={setDropTargetPath}
            onRequestFocus={requestRowFocus}
          />
        ))}
        <li
          className="tree-root-drop-spacer"
          aria-hidden="true"
          onContextMenu={openRootContextMenu}
        />
      </ul>
    </div>
  );
}
