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
    get().clearPendingOpen();
    expect(get().pendingOpenPath).toBeNull();
  });

  it("openWorkspace clears any pending open intent", () => {
    get().requestOpenFile("/x");
    get().openWorkspace("/tmp/p2");
    expect(get().pendingOpenPath).toBeNull();
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
