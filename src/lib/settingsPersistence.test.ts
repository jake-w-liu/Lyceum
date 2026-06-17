import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
const readFileMock = vi.hoisted(() => vi.fn());
const writeFileMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("./ipc", () => ({
  canonicalizePath: vi.fn(async (path: string) => path),
  readFile: (...args: unknown[]) => readFileMock(...args),
  writeFile: (...args: unknown[]) => writeFileMock(...args),
}));

import {
  flushSettingsPersistence,
  initSettingsPersistence,
  legacyConfigPath,
  resetSettingsPersistenceForTests,
  saveLayout,
  saveSettings,
} from "./settingsPersistence";
import { initialLayoutData, useLayoutStore } from "../state/layoutStore";
import {
  DEFAULT_SETTINGS,
  initialSettingsData,
  useSettingsStore,
} from "../state/settingsStore";

beforeEach(() => {
  invokeMock.mockReset();
  readFileMock.mockReset();
  writeFileMock.mockReset();
});

afterEach(() => {
  resetSettingsPersistenceForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  useLayoutStore.setState(initialLayoutData, false);
  useSettingsStore.setState(initialSettingsData, false);
});

async function flushPromises(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

describe("settingsPersistence", () => {
  it("maps the old bundle-id config directory to the new one for migration", () => {
    expect(
      legacyConfigPath(
        "/Users/jake/Library/Application Support/dev.lyceum/settings.json",
      ),
    ).toBe(
      "/Users/jake/Library/Application Support/dev.lyceum.app/settings.json",
    );
    expect(
      legacyConfigPath("C:\\Users\\jake\\AppData\\Roaming\\dev.lyceum\\workspace.json"),
    ).toBe("C:\\Users\\jake\\AppData\\Roaming\\dev.lyceum.app\\workspace.json");
  });

  it("does not rewrite unrelated config paths", () => {
    expect(
      legacyConfigPath("/Users/jake/Library/Application Support/dev.other/settings.json"),
    ).toBeNull();
  });

  it("keeps best-effort saves quiet outside Tauri", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await saveLayout();

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("keeps settings keys dirty when a write fails", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let disk = JSON.stringify({ ...DEFAULT_SETTINGS, fontSize: 13 });
    invokeMock.mockImplementation(async (_cmd: string, args: { name: string }) =>
      `/config/${args.name}`,
    );
    readFileMock.mockImplementation(async () => disk);
    writeFileMock
      .mockRejectedValueOnce(new Error("disk full"))
      .mockImplementationOnce(async (_path: string, content: string) => {
        disk = content;
      });

    initSettingsPersistence();
    useSettingsStore.getState().setSetting("fontSize", 14);

    await saveSettings();
    await saveSettings();

    expect(JSON.parse(disk).fontSize).toBe(14);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("does not clear newer same-key edits when an older save completes", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    let disk = JSON.stringify({ ...DEFAULT_SETTINGS, fontSize: 13 });
    let releaseFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    invokeMock.mockImplementation(async (_cmd: string, args: { name: string }) =>
      `/config/${args.name}`,
    );
    readFileMock.mockImplementation(async () => disk);
    writeFileMock.mockImplementation(async (_path: string, content: string) => {
      if (writeFileMock.mock.calls.length === 1) {
        await firstWrite;
      }
      disk = content;
    });

    initSettingsPersistence();
    useSettingsStore.getState().setSetting("fontSize", 14);
    const save = saveSettings();
    await flushPromises();
    expect(writeFileMock).toHaveBeenCalledTimes(1);

    useSettingsStore.getState().setSetting("fontSize", 15);
    releaseFirstWrite();
    await save;
    await saveSettings();

    expect(JSON.parse(disk).fontSize).toBe(15);
  });

  it("flushes pending debounced settings and layout saves", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    invokeMock.mockImplementation(async (_cmd: string, args: { name: string }) =>
      `/config/${args.name}`,
    );
    readFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith("settings.json")) return JSON.stringify(DEFAULT_SETTINGS);
      return "{}";
    });
    writeFileMock.mockResolvedValue(undefined);

    initSettingsPersistence();
    useSettingsStore
      .getState()
      .setSetting("fontSize", DEFAULT_SETTINGS.fontSize + 1);
    useLayoutStore.getState().setSidebarWidth(333);

    await flushSettingsPersistence();
    await flushPromises();

    expect(writeFileMock).toHaveBeenCalledTimes(2);
    expect(writeFileMock).toHaveBeenCalledWith(
      "/config/settings.json",
      expect.stringContaining(`"fontSize": ${DEFAULT_SETTINGS.fontSize + 1}`),
    );
    expect(writeFileMock).toHaveBeenCalledWith(
      "/config/layout.json",
      expect.stringContaining('"sidebarWidth": 333'),
    );

    vi.advanceTimersByTime(400);
    await flushPromises();

    expect(writeFileMock).toHaveBeenCalledTimes(2);
  });
});
