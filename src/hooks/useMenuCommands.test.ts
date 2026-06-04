// Tests that the native-menu event listener is always torn down — including the
// race where the effect cleanup runs before the async listen() promise resolves.

import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const { listenMock, getResolve } = vi.hoisted(() => {
  let resolve: ((fn: () => void) => void) | null = null;
  const listenMock = vi.fn(
    () =>
      new Promise<() => void>((r) => {
        resolve = r;
      }),
  );
  return { listenMock, getResolve: () => resolve };
});

vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

import { useMenuCommands } from "./useMenuCommands";

describe("useMenuCommands", () => {
  it("unlistens immediately if cleaned up before listen() resolves", async () => {
    const unlisten = vi.fn();
    const { unmount } = renderHook(() => useMenuCommands());

    // Tear down BEFORE the listen() promise resolves.
    unmount();
    // listen() now resolves with the real unlisten fn — it must be called at once
    // (otherwise the 'menu' listener would leak and re-fire every command).
    getResolve()?.(unlisten);
    await Promise.resolve();
    await Promise.resolve();

    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("unlistens on normal unmount after listen() resolves", async () => {
    const unlisten = vi.fn();
    const { unmount } = renderHook(() => useMenuCommands());

    getResolve()?.(unlisten);
    await Promise.resolve();
    await Promise.resolve();
    expect(unlisten).not.toHaveBeenCalled();

    unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
