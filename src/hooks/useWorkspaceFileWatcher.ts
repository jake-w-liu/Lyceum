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
import { useTreeStore } from "../state/treeStore";
import { useWorkspaceStore } from "../state/workspaceStore";

const REFRESH_DEBOUNCE_MS = 150;

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

    const clearRefreshTimer = () => {
      if (refreshTimer) {
        window.clearTimeout(refreshTimer);
        refreshTimer = 0;
      }
    };

    const scheduleRefresh = (event: Event<WorkspaceFsEvent>) => {
      if (normalizedRoot(event.payload.root) !== normalizedRoot(rootPath)) return;
      for (const path of event.payload.paths) pendingPaths.add(path);
      clearRefreshTimer();
      refreshTimer = window.setTimeout(() => {
        refreshTimer = 0;
        const paths = Array.from(pendingPaths);
        pendingPaths.clear();
        if (
          normalizedRoot(useWorkspaceStore.getState().rootPath) !==
          normalizedRoot(rootPath)
        ) {
          return;
        }
        useTreeStore.getState().refresh();
        void reloadOpenEditorPaths(paths);
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
