// Settings & workspace persistence (M10). Settings, the last workspace, and
// the workbench layout are stored as JSON in the OS app-config dir (path resolved by the Rust
// `app_config_path` command; written via `write_file`, which creates parent
// dirs). Loading degrades gracefully to defaults when no file exists.

import { invoke } from "@tauri-apps/api/core";
import { canonicalizePath, readFile, writeFile } from "./ipc";
import {
  type LayoutData,
  persistedLayoutData,
  sanitizeLayoutData,
  useLayoutStore,
} from "../state/layoutStore";
import { mergeSettings, useSettingsStore } from "../state/settingsStore";
import { useThemeStore } from "../state/themeStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import { parseUserKeybindings, useKeymapStore } from "../state/keymapStore";

const SETTINGS_FILE = "settings.json";
const WORKSPACE_FILE = "workspace.json";
const LAYOUT_FILE = "layout.json";

function configPath(name: string): Promise<string> {
  if (!isTauriRuntimeAvailable()) {
    return Promise.reject(new Error("Tauri runtime unavailable"));
  }
  return invoke<string>("app_config_path", { name });
}

function isTauriRuntimeAvailable(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function logPersistenceError(message: string, error: unknown): void {
  if (isTauriRuntimeAvailable()) {
    console.error(message, error);
  }
}

export function legacyConfigPath(path: string): string | null {
  const match = path.match(/^(.*[/\\])dev\.lyceum([/\\][^/\\]+)$/);
  if (!match) return null;
  return `${match[1]}dev.lyceum.app${match[2]}`;
}

async function readConfigFile(name: string): Promise<string> {
  const path = await configPath(name);
  try {
    return await readFile(path);
  } catch (primaryError) {
    const legacyPath = legacyConfigPath(path);
    if (legacyPath) {
      try {
        return await readFile(legacyPath);
      } catch {
        // Keep the original error; callers already treat missing config as
        // defaults, and the legacy path is only a migration convenience.
      }
    }
    throw primaryError;
  }
}

/** The on-disk settings.json path (used by the "Open Settings" command). */
export function settingsFilePath(): Promise<string> {
  return configPath(SETTINGS_FILE);
}

export async function loadSettings(): Promise<void> {
  try {
    const raw = await readConfigFile(SETTINGS_FILE);
    useSettingsStore.getState().replaceAll(mergeSettings(JSON.parse(raw)));
  } catch {
    // No settings file yet (or not in Tauri) — keep defaults.
  }
  useThemeStore.getState().setTheme(useSettingsStore.getState().settings.theme);
}

/** Load user keybindings.json (if present) and merge over the defaults. */
export async function loadKeybindings(): Promise<void> {
  try {
    const raw = JSON.parse(await readConfigFile("keybindings.json"));
    useKeymapStore.getState().setUserKeybindings(parseUserKeybindings(raw));
  } catch {
    // No user keybindings → defaults only.
  }
}

// Top-level keys this window changed since its last successful save. Used to
// read-modify-write the shared config file so a different key changed in another
// window (which shares the SAME config file but does NOT sync stores) survives
// instead of being clobbered by a last-writer-wins full overwrite.
const dirtySettingsKeys = new Map<string, number>();
const dirtyLayoutKeys = new Map<string, number>();
let settingsDirtyRevision = 0;
let layoutDirtyRevision = 0;
// True while `loadLayout` applies the persisted layout, so the layout
// subscription ignores that programmatic setState (neither marks keys dirty nor
// schedules a redundant save).
let applyingPersistedLayout = false;

/** Parse a config file into a plain object, or `{}` if absent/invalid. */
async function readConfigObject(name: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readConfigFile(name));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Merge this window's full state with the on-disk file: every key gets this
 * window's value EXCEPT keys it did not change since the last save, which keep
 * the on-disk value (possibly written by another window). Writes a complete file
 * while never reverting a concurrent change to a key this window didn't touch.
 */
function mergeForWrite(
  mine: Record<string, unknown>,
  onDisk: Record<string, unknown>,
  dirty: ReadonlyMap<string, number>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...mine };
  for (const k of Object.keys(onDisk)) {
    if (!dirty.has(k)) merged[k] = onDisk[k];
  }
  return merged;
}

function clearSavedDirtyKeys(
  dirty: Map<string, number>,
  saved: ReadonlyMap<string, number>,
): void {
  for (const [key, revision] of saved) {
    if (dirty.get(key) === revision) dirty.delete(key);
  }
}

export async function saveSettings(): Promise<void> {
  try {
    const path = await configPath(SETTINGS_FILE);
    const onDisk = await readConfigObject(SETTINGS_FILE);
    const mine = useSettingsStore.getState().settings as unknown as Record<
      string,
      unknown
    >;
    const dirtyAtStart = new Map(dirtySettingsKeys);
    const merged = mergeForWrite(mine, onDisk, dirtyAtStart);
    await writeFile(path, JSON.stringify(merged, null, 2));
    clearSavedDirtyKeys(dirtySettingsKeys, dirtyAtStart);
  } catch (e) {
    logPersistenceError("Failed to save settings", e);
  }
}

/** Restore the persisted workbench layout (sidebar/panel sizes, visibility,
 *  dock position). Unknown/invalid fields fall back to the defaults. */
export async function loadLayout(): Promise<void> {
  try {
    const raw = JSON.parse(await readConfigFile(LAYOUT_FILE));
    const data = sanitizeLayoutData(raw) as Record<string, unknown>;
    // Apply only keys the user has NOT already changed since startup, so a
    // layout toggle made during this load's async round-trip (e.g. Cmd+B before
    // the file resolves) isn't reverted by the restore.
    const toApply: Record<string, unknown> = {};
    for (const k of Object.keys(data)) {
      if (!dirtyLayoutKeys.has(k)) toApply[k] = data[k];
    }
    if (Object.keys(toApply).length > 0) {
      applyingPersistedLayout = true;
      try {
        useLayoutStore.setState(toApply as Partial<LayoutData>);
      } finally {
        applyingPersistedLayout = false;
      }
    }
  } catch {
    // No layout file yet (or not in Tauri) — keep defaults.
  }
}

export async function saveLayout(): Promise<void> {
  try {
    const path = await configPath(LAYOUT_FILE);
    const onDisk = await readConfigObject(LAYOUT_FILE);
    const mine = persistedLayoutData(useLayoutStore.getState()) as unknown as Record<
      string,
      unknown
    >;
    const dirtyAtStart = new Map(dirtyLayoutKeys);
    const merged = mergeForWrite(mine, onDisk, dirtyAtStart);
    await writeFile(path, JSON.stringify(merged, null, 2));
    clearSavedDirtyKeys(dirtyLayoutKeys, dirtyAtStart);
  } catch (e) {
    logPersistenceError("Failed to save layout", e);
  }
}

async function saveLastWorkspace(path: string | null): Promise<void> {
  try {
    await writeFile(
      await configPath(WORKSPACE_FILE),
      JSON.stringify({ rootPath: path }),
    );
  } catch {
    // best-effort
  }
}

export async function restoreWorkspace(): Promise<void> {
  if (!useSettingsStore.getState().settings.restoreWorkspaceOnStartup) return;
  try {
    const data = JSON.parse(await readConfigFile(WORKSPACE_FILE));
    if (data && typeof data.rootPath === "string") {
      // Canonicalize so the tree, git decorations, search, and watcher all key
      // off one symlink-free root (see canonicalizePath).
      const root = await canonicalizePath(data.rootPath);
      useWorkspaceStore.getState().openWorkspace(root);
    }
  } catch {
    // no saved workspace
  }
}

/**
 * If launched with a folder argument (`lyceum /path`, i.e. `open -na Lyceum
 * --args /path`), open it as the workspace — overriding any restored workspace.
 * No-op for a plain launch or outside Tauri.
 */
export async function openLaunchDir(): Promise<void> {
  try {
    const dir = await invoke<string | null>("get_launch_dir");
    if (typeof dir === "string" && dir.length > 0) {
      useWorkspaceStore.getState().openWorkspace(dir);
    }
  } catch {
    // not in Tauri, or no launch dir
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let layoutSaveTimer: ReturnType<typeof setTimeout> | null = null;
let persistenceInitialized = false;
let persistenceUnsubscribes: Array<() => void> = [];

export function resetSettingsPersistenceForTests(): void {
  if (saveTimer) clearTimeout(saveTimer);
  if (layoutSaveTimer) clearTimeout(layoutSaveTimer);
  saveTimer = null;
  layoutSaveTimer = null;
  for (const unsubscribe of persistenceUnsubscribes) unsubscribe();
  persistenceUnsubscribes = [];
  persistenceInitialized = false;
  dirtySettingsKeys.clear();
  dirtyLayoutKeys.clear();
  settingsDirtyRevision = 0;
  layoutDirtyRevision = 0;
  applyingPersistedLayout = false;
}

/** Subscribe stores so changes are persisted (debounced) and theme stays synced. */
export function initSettingsPersistence(): void {
  if (persistenceInitialized) return;
  persistenceInitialized = true;
  persistenceUnsubscribes.push(useSettingsStore.subscribe((s, prev) => {
    const cur = s.settings as unknown as Record<string, unknown>;
    const old = prev.settings as unknown as Record<string, unknown>;
    for (const k of Object.keys(cur)) {
      if (cur[k] !== old[k]) dirtySettingsKeys.set(k, ++settingsDirtyRevision);
    }
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void saveSettings(), 400);
  }));
  // Subscribe layout persistence BEFORE loading, so a layout change made during
  // loadLayout's async round-trip is recorded and persisted (not lost). The
  // restore's own setState is ignored via `applyingPersistedLayout`, so it
  // doesn't re-save what was just read.
  persistenceUnsubscribes.push(useLayoutStore.subscribe((s, prev) => {
    if (applyingPersistedLayout) return;
    const cur = persistedLayoutData(s) as unknown as Record<string, unknown>;
    const old = persistedLayoutData(prev) as unknown as Record<string, unknown>;
    let changed = false;
    for (const k of Object.keys(cur)) {
      if (cur[k] !== old[k]) {
        dirtyLayoutKeys.set(k, ++layoutDirtyRevision);
        changed = true;
      }
    }
    // No persisted field changed (e.g. only the transient editorPreview toggled)
    // — nothing to write.
    if (!changed) return;
    if (layoutSaveTimer) clearTimeout(layoutSaveTimer);
    layoutSaveTimer = setTimeout(() => void saveLayout(), 400);
  }));
  void loadLayout();
  // Theme changed via the palette → reflect into settings (which persists it).
  persistenceUnsubscribes.push(useThemeStore.subscribe((s) => {
    if (useSettingsStore.getState().settings.theme !== s.theme) {
      useSettingsStore.getState().setSetting("theme", s.theme);
    }
  }));
  // Persist the opened folder for restore-on-startup.
  persistenceUnsubscribes.push(useWorkspaceStore.subscribe((s, prev) => {
    if (s.rootPath !== prev.rootPath) void saveLastWorkspace(s.rootPath);
  }));
  // Flush a pending debounced save when the window is closing, so a settings
  // change made within the debounce window isn't lost on quit.
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", () => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        void saveSettings();
      }
      if (layoutSaveTimer) {
        clearTimeout(layoutSaveTimer);
        layoutSaveTimer = null;
        void saveLayout();
      }
    });
  }
}
