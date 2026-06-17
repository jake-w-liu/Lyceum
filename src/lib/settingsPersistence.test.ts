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
  initSettingsPersistence,
  legacyConfigPath,
  resetSettingsPersistenceForTests,
  saveLayout,
  saveSettings,
} from "./settingsPersistence";
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
});
