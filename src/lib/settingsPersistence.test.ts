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

  it("re-persists a clamped value (not the invalid on-disk value) for an unchanged key", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    // settings.json was hand-edited to an out-of-range fontSize.
    let disk = JSON.stringify({ ...DEFAULT_SETTINGS, fontSize: 9999 });
    invokeMock.mockImplementation(async (_cmd: string, args: { name: string }) =>
      `/config/${args.name}`,
    );
    readFileMock.mockImplementation(async () => disk);
    writeFileMock.mockImplementation(async (_path: string, content: string) => {
      disk = content;
    });

    initSettingsPersistence();
    // Change an UNRELATED key so fontSize stays non-dirty (cross-window-preserved).
    useSettingsStore.getState().setSetting("fontFamily", "Iosevka Test");
    await saveSettings();

    // The invalid 9999 must be clamped (max 40) on write, not copied back verbatim.
    expect(JSON.parse(disk).fontSize).toBe(40);
  });

  it("writes the current settings version even when disk holds an older one", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    // An upgraded user's file still carries the old schema version on disk.
    let disk = JSON.stringify({ ...DEFAULT_SETTINGS, version: 1 });
    invokeMock.mockImplementation(async (_cmd: string, args: { name: string }) =>
      `/config/${args.name}`,
    );
    readFileMock.mockImplementation(async () => disk);
    writeFileMock.mockImplementation(async (_path: string, content: string) => {
      disk = content;
    });

    initSettingsPersistence();
    useSettingsStore.getState().setSetting("fontFamily", "Iosevka Test");
    await saveSettings();

    // version is owned by the running process and must advance, not stay pinned
    // at the stale on-disk value (which would re-run version-gated migrations).
    expect(JSON.parse(disk).version).toBe(DEFAULT_SETTINGS.version);
  });

  it("serializes overlapping saves so an out-of-order write can't clobber the newer value", async () => {
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
      // Make the FIRST write complete LAST — the classic reorder hazard.
      if (writeFileMock.mock.calls.length === 1) await firstWrite;
      disk = content;
    });

    initSettingsPersistence();
    useSettingsStore.getState().setSetting("fontSize", 14);
    const a = saveSettings(); // captures 14; its write blocks
    await flushPromises();
    useSettingsStore.getState().setSetting("fontSize", 15);
    const b = saveSettings(); // serialized AFTER a (a is still in flight)
    await flushPromises();
    releaseFirstWrite(); // a's write finally completes, out of order
    await Promise.all([a, b]);

    // b runs only after a finishes, re-reads disk, and writes the newer 15 last.
    // Without serialization a's late write would clobber the file back to 14.
    expect(JSON.parse(disk).fontSize).toBe(15);
  });

  it("heals a corrupt layout enum value instead of re-persisting it for an unchanged key", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    // layout.json hand-edited (or written by a future version) with an invalid
    // dock position; this window does not change panelPosition this session.
    let disk = JSON.stringify({ sidebarWidth: 200, panelPosition: "left" });
    invokeMock.mockImplementation(async (_cmd: string, args: { name: string }) =>
      `/config/${args.name}`,
    );
    readFileMock.mockImplementation(async () => disk);
    writeFileMock.mockImplementation(async (_path: string, content: string) => {
      disk = content;
    });

    initSettingsPersistence();
    // Change an UNRELATED layout key so panelPosition stays non-dirty.
    useLayoutStore.getState().setSidebarWidth(321);
    await saveLayout();

    // sanitizeLayoutData drops the invalid enum; the defaults-fill replaces it
    // with a valid default rather than copying "left" back verbatim.
    const written = JSON.parse(disk);
    expect(written.panelPosition).not.toBe("left");
    expect(["bottom", "right"]).toContain(written.panelPosition);
  });

  it("preserves non-dirty settings when the on-disk file is corrupt (no revert to defaults)", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    // A previously-good file had loaded fontSize=20 into memory (non-dirty)...
    useSettingsStore.setState(
      { settings: { ...DEFAULT_SETTINGS, fontSize: 20 } },
      false,
    );
    // ...but settings.json is now corrupt (hand-edited syntax error).
    let disk = "{ not valid json";
    invokeMock.mockImplementation(async (_cmd: string, args: { name: string }) =>
      `/config/${args.name}`,
    );
    readFileMock.mockImplementation(async () => disk);
    writeFileMock.mockImplementation(async (_path: string, content: string) => {
      disk = content;
    });

    initSettingsPersistence();
    // Change one unrelated key this session.
    useSettingsStore.getState().setSetting("fontFamily", "Iosevka Test");
    await saveSettings();

    const written = JSON.parse(disk);
    // The non-dirty fontSize MUST survive (not revert to the default 13), and the
    // corrupt file is healed with valid JSON.
    expect(written.fontSize).toBe(20);
    expect(written.fontFamily).toBe("Iosevka Test");
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
