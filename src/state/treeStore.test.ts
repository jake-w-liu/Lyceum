import { beforeEach, describe, expect, it } from "vitest";
import type { DirEntry } from "../lib/ipc";
import { initialTreeData, useTreeStore } from "./treeStore";

const get = () => useTreeStore.getState();

const entry = (name: string, isDir = false): DirEntry => ({
  name,
  path: `/root/${name}`,
  isDir,
});

describe("treeStore", () => {
  beforeEach(() => useTreeStore.setState(initialTreeData, false));

  it("setChildren stores entries per path", () => {
    const a = [entry("a.txt"), entry("sub", true)];
    const b = [entry("b.txt")];
    get().setChildren("/root", a);
    get().setChildren("/root/sub", b);
    expect(get().children["/root"]).toEqual(a);
    expect(get().children["/root/sub"]).toEqual(b);
  });

  it("toggleExpanded flips a path", () => {
    get().toggleExpanded("/root");
    expect(get().expanded["/root"]).toBe(true);
    get().toggleExpanded("/root");
    expect(get().expanded["/root"]).toBe(false);
  });

  it("setExpanded sets an explicit value", () => {
    get().setExpanded("/root", true);
    expect(get().expanded["/root"]).toBe(true);
  });

  it("collapseAll empties expanded but keeps the children cache", () => {
    const a = [entry("a.txt")];
    get().setChildren("/root", a);
    get().setExpanded("/root", true);
    get().collapseAll();
    expect(get().expanded).toEqual({});
    expect(get().children["/root"]).toEqual(a);
  });

  it("refresh clears children and increments refreshNonce", () => {
    get().setChildren("/root", [entry("a.txt")]);
    expect(get().refreshNonce).toBe(0);
    get().refresh();
    expect(get().children).toEqual({});
    expect(get().refreshNonce).toBe(1);
    get().refresh();
    expect(get().refreshNonce).toBe(2);
  });

  it("expandPaths marks multiple paths expanded true", () => {
    get().expandPaths(["/root", "/root/sub", "/root/sub/deep"]);
    expect(get().expanded["/root"]).toBe(true);
    expect(get().expanded["/root/sub"]).toBe(true);
    expect(get().expanded["/root/sub/deep"]).toBe(true);
  });

  it("reset restores defaults", () => {
    get().setChildren("/root", [entry("a.txt")]);
    get().setExpanded("/root", true);
    get().refresh();
    get().reset();
    expect(get().expanded).toEqual({});
    expect(get().children).toEqual({});
    expect(get().refreshNonce).toBe(0);
  });

  it("selects one path, toggles individual paths, and clears selection", () => {
    get().selectSingle("/root/a.txt");
    expect(get().selectedPaths).toEqual(["/root/a.txt"]);
    expect(get().anchorPath).toBe("/root/a.txt");

    get().toggleSelected("/root/b.txt");
    expect(get().selectedPaths).toEqual(["/root/a.txt", "/root/b.txt"]);
    expect(get().anchorPath).toBe("/root/b.txt");

    get().toggleSelected("/root/a.txt");
    expect(get().selectedPaths).toEqual(["/root/b.txt"]);

    get().clearSelection();
    expect(get().selectedPaths).toEqual([]);
    expect(get().anchorPath).toBeNull();
    expect(get().focusedPath).toBeNull();
  });

  it("selectRange selects a contiguous visible range from the anchor", () => {
    const visible = ["/root/a", "/root/b", "/root/c", "/root/d"];
    get().selectSingle("/root/b");

    get().selectRange(visible, "/root/d");

    expect(get().selectedPaths).toEqual(["/root/b", "/root/c", "/root/d"]);
    expect(get().anchorPath).toBe("/root/b");
    expect(get().focusedPath).toBe("/root/d");
  });

  it("records undoable delete batches and supports redo stack movement", () => {
    const batch = {
      id: "batch-1",
      items: [
        {
          originalPath: "/root/a.txt",
          trashedPath: "/root/.lyceum-trash/batch-1/a.txt",
          isDir: false,
        },
      ],
    };

    get().recordDeleteBatch(batch);
    expect(get().deleteUndoStack).toEqual([batch]);
    expect(get().deleteRedoStack).toEqual([]);

    const undo = get().popDeleteUndo();
    expect(undo).toEqual(batch);
    expect(get().deleteUndoStack).toEqual([]);

    get().pushDeleteRedo(batch);
    expect(get().popDeleteRedo()).toEqual(batch);
  });

  it("requestCreate sets a pending create kind that consumeCreateRequest clears", () => {
    expect(get().createRequest).toBeNull();

    get().requestCreate("file");
    expect(get().createRequest).toBe("file");

    get().consumeCreateRequest();
    expect(get().createRequest).toBeNull();

    get().requestCreate("folder");
    expect(get().createRequest).toBe("folder");
  });
});
