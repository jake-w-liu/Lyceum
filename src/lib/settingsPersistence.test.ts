import { afterEach, describe, expect, it, vi } from "vitest";

import { legacyConfigPath, saveLayout } from "./settingsPersistence";

afterEach(() => {
  vi.restoreAllMocks();
});

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
});
