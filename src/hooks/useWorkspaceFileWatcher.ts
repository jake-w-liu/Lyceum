import { useEffect } from "react";
import { type UnlistenFn } from "@tauri-apps/api/event";
import type { Event } from "@tauri-apps/api/event";
import { listenScoped } from "../lib/windowEvents";
import {
  unwatchWorkspace,
  watchWorkspace,
  type WorkspaceFsEvent,
} from "../lib/ipc";
import { reloadOpenEditorPaths } from "../lib/editorReload";
import { useEditorStore } from "../state/editorStore";
import { useGitStore } from "../state/gitStore";
import { useTreeStore } from "../state/treeStore";
import { useWorkspaceStore } from "../state/workspaceStore";

const REFRESH_DEBOUNCE_MS = 150;
const MAX_PENDING_RELOAD_PATHS = 2_000;

function normalizedRoot(path: string | null): string {
  if (!path) return "";
  const normalized = path.replace(/\\/g, "/");
  if (normalized === "/") return normalized;
  return normalized.replace(/\/+$/, "") || normalized;
}

export function useWorkspaceFileWatcher(): void {
  const rootPath = useWorkspaceStore((s) => s.rootPath);

  useEffect(() => {
    if (!rootPath) {
      void unwatchWorkspace().catch(() => {});
      return;
    }

    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    let refreshTimer = 0;
    const pendingPaths = new Set<string>();
    let pendingGitRefresh = false;
    let pendingTreeRefresh = false;
    let reloadAllOpenDocs = false;

    const clearRefreshTimer = () => {
      if (refreshTimer) {
        window.clearTimeout(refreshTimer);
        refreshTimer = 0;
      }
    };

    const scheduleRefresh = (event: Event<WorkspaceFsEvent>) => {
      if (normalizedRoot(event.payload.root) !== normalizedRoot(rootPath)) return;
      if (!reloadAllOpenDocs) {
        for (const path of event.payload.paths) {
          pendingPaths.add(path);
          if (pendingPaths.size > MAX_PENDING_RELOAD_PATHS) {
            pendingPaths.clear();
            reloadAllOpenDocs = true;
            break;
          }
        }
      }
      const gitChanged = Boolean(event.payload.gitChanged);
      pendingGitRefresh ||= gitChanged;
      pendingTreeRefresh ||= event.payload.paths.length > 0 || !gitChanged;
      clearRefreshTimer();
      refreshTimer = window.setTimeout(() => {
        refreshTimer = 0;
        const paths = reloadAllOpenDocs
          ? useEditorStore.getState().docs.map((doc) => doc.path)
          : Array.from(pendingPaths);
        const refreshGit = pendingGitRefresh;
        const refreshTree = pendingTreeRefresh;
        pendingPaths.clear();
        pendingGitRefresh = false;
        pendingTreeRefresh = false;
        reloadAllOpenDocs = false;
        if (
          normalizedRoot(useWorkspaceStore.getState().rootPath) !==
          normalizedRoot(rootPath)
        ) {
          return;
        }
        if (refreshTree) {
          useTreeStore.getState().refresh();
          void reloadOpenEditorPaths(paths);
        }
        if (refreshGit) void useGitStore.getState().refresh();
      }, REFRESH_DEBOUNCE_MS);
    };

    void (async () => {
      try {
        const fn = await listenScoped<WorkspaceFsEvent>(
          "workspace:fs-change",
          scheduleRefresh,
        );
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      } catch {
        /* not running inside Tauri */
        return;
      }

      try {
        await watchWorkspace(rootPath);
        if (disposed) {
          void unwatchWorkspace(rootPath).catch(() => {});
        }
      } catch {
        /* not running inside Tauri or watcher unavailable */
      }
    })();

    return () => {
      disposed = true;
      clearRefreshTimer();
      unlisten?.();
      void unwatchWorkspace(rootPath).catch(() => {});
    };
  }, [rootPath]);
}
