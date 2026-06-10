import { beforeEach, describe, expect, it } from "vitest";
import {
  baseName,
  initialWorkspaceData,
  useWorkspaceStore,
} from "./workspaceStore";

const reset = () => useWorkspaceStore.setState(initialWorkspaceData, false);
const get = () => useWorkspaceStore.getState();

describe("workspaceStore", () => {
  beforeEach(reset);

  it("opens and closes a workspace", () => {
    get().openWorkspace("/tmp/project");
    expect(get().rootPath).toBe("/tmp/project");
    get().closeWorkspace();
    expect(get().rootPath).toBeNull();
  });

  it("records and clears an open-file intent", () => {
    get().requestOpenFile("/tmp/project/a.ts");
    expect(get().pendingOpenPath).toBe("/tmp/project/a.ts");
    expect(get().pendingOpenPosition).toBeNull();
    get().clearPendingOpen();
    expect(get().pendingOpenPath).toBeNull();
  });

  it("records an optional target position and clears it with the intent", () => {
    get().requestOpenFile("/tmp/project/a.ts", { line: 12, column: 3 });
    expect(get().pendingOpenPosition).toEqual({ line: 12, column: 3 });
    get().clearPendingOpen();
    expect(get().pendingOpenPosition).toBeNull();
  });

  it("bumps pendingOpenSeq on every request so same-path requests re-trigger", () => {
    const before = get().pendingOpenSeq;
    get().requestOpenFile("/x", { line: 1 });
    get().requestOpenFile("/x", { line: 2 });
    expect(get().pendingOpenSeq).toBe(before + 2);
    expect(get().pendingOpenPosition).toEqual({ line: 2 });
  });

  it("openWorkspace clears any pending open intent", () => {
    get().requestOpenFile("/x", { line: 4 });
    get().openWorkspace("/tmp/p2");
    expect(get().pendingOpenPath).toBeNull();
    expect(get().pendingOpenPosition).toBeNull();
  });
});

describe("baseName", () => {
  it("returns the final path segment", () => {
    expect(baseName("/Users/jake/lyceum")).toBe("lyceum");
    expect(baseName("/Users/jake/lyceum/")).toBe("lyceum");
    expect(baseName("C:\\Users\\jake\\proj")).toBe("proj");
    expect(baseName("solo")).toBe("solo");
  });
});
