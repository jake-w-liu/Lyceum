// Settings & workspace persistence (M10). Settings and the last workspace are
// stored as JSON in the OS app-config dir (path resolved by the Rust
// `app_config_path` command; written via `write_file`, which creates parent
// dirs). Loading degrades gracefully to defaults when no file exists.

import { invoke } from "@tauri-apps/api/core";
import { readFile, writeFile } from "./ipc";
import { mergeSettings, useSettingsStore } from "../state/settingsStore";
import { useThemeStore } from "../state/themeStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import { parseUserKeybindings, useKeymapStore } from "../state/keymapStore";

const SETTINGS_FILE = "settings.json";
const WORKSPACE_FILE = "workspace.json";

function configPath(name: string): Promise<string> {
  return invoke<string>("app_config_path", { name });
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

export async function saveSettings(): Promise<void> {
  try {
    await writeFile(
      await configPath(SETTINGS_FILE),
      JSON.stringify(useSettingsStore.getState().settings, null, 2),
    );
  } catch (e) {
    console.error("Failed to save settings", e);
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
      useWorkspaceStore.getState().openWorkspace(data.rootPath);
    }
  } catch {
    // no saved workspace
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let persistenceInitialized = false;

/** Subscribe stores so changes are persisted (debounced) and theme stays synced. */
export function initSettingsPersistence(): void {
  if (persistenceInitialized) return;
  persistenceInitialized = true;
  useSettingsStore.subscribe(() => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void saveSettings(), 400);
  });
  // Theme changed via the palette → reflect into settings (which persists it).
  useThemeStore.subscribe((s) => {
    if (useSettingsStore.getState().settings.theme !== s.theme) {
      useSettingsStore.getState().setSetting("theme", s.theme);
    }
  });
  // Persist the opened folder for restore-on-startup.
  useWorkspaceStore.subscribe((s, prev) => {
    if (s.rootPath !== prev.rootPath) void saveLastWorkspace(s.rootPath);
  });
}
