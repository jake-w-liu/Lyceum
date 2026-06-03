// Unit tests for the editor store: open/close/activate tabs, dirty tracking,
// and the pure getActiveDoc/isDirty helpers.

import { beforeEach, describe, expect, it } from "vitest";

import {
  getActiveDoc,
  initialEditorData,
  isDirty,
  useEditorStore,
} from "./editorStore";

beforeEach(() => {
  useEditorStore.setState(initialEditorData, false);
});

describe("editorStore", () => {
  it("openDoc adds a doc and makes it active with a basename", () => {
    useEditorStore.getState().openDoc({
      path: "/proj/src/main.ts",
      content: "hello",
      language: "typescript",
    });

    const state = useEditorStore.getState();
    expect(state.docs).toHaveLength(1);
    expect(state.activePath).toBe("/proj/src/main.ts");
    expect(state.docs[0].name).toBe("main.ts");
    expect(state.docs[0].savedContent).toBe("hello");
  });

  it("openDoc with an existing path does not duplicate, just activates", () => {
    const { openDoc } = useEditorStore.getState();
    openDoc({ path: "/a.ts", content: "a", language: "typescript" });
    openDoc({ path: "/b.ts", content: "b", language: "typescript" });
    expect(useEditorStore.getState().activePath).toBe("/b.ts");

    openDoc({ path: "/a.ts", content: "IGNORED", language: "typescript" });
    const state = useEditorStore.getState();
    expect(state.docs).toHaveLength(2);
    expect(state.activePath).toBe("/a.ts");
    expect(state.docs[0].content).toBe("a");
  });

  it("updateContent makes the doc dirty and markSaved clears it", () => {
    const store = useEditorStore.getState();
    store.openDoc({ path: "/a.ts", content: "a", language: "typescript" });

    store.updateContent("/a.ts", "a changed");
    let doc = useEditorStore.getState().docs[0];
    expect(doc.content).toBe("a changed");
    expect(isDirty(doc)).toBe(true);

    store.markSaved("/a.ts");
    doc = useEditorStore.getState().docs[0];
    expect(doc.savedContent).toBe("a changed");
    expect(isDirty(doc)).toBe(false);
  });

  it("closeDoc reassigns, nulls, or keeps activePath appropriately", () => {
    const store = useEditorStore.getState();
    store.openDoc({ path: "/a.ts", content: "a", language: "typescript" });
    store.openDoc({ path: "/b.ts", content: "b", language: "typescript" });
    store.openDoc({ path: "/c.ts", content: "c", language: "typescript" });

    // Active is /c.ts (last opened). Closing it falls back to the previous doc.
    store.closeDoc("/c.ts");
    expect(useEditorStore.getState().activePath).toBe("/b.ts");

    // Closing a non-active doc keeps the active one.
    store.closeDoc("/a.ts");
    expect(useEditorStore.getState().activePath).toBe("/b.ts");
    expect(useEditorStore.getState().docs).toHaveLength(1);

    // Closing the last doc sets activePath to null.
    store.closeDoc("/b.ts");
    const state = useEditorStore.getState();
    expect(state.docs).toHaveLength(0);
    expect(state.activePath).toBeNull();
  });

  it("getActiveDoc returns the active doc or null", () => {
    expect(getActiveDoc(useEditorStore.getState())).toBeNull();

    const store = useEditorStore.getState();
    store.openDoc({ path: "/a.ts", content: "a", language: "typescript" });
    store.openDoc({ path: "/b.ts", content: "b", language: "typescript" });

    const active = getActiveDoc(useEditorStore.getState());
    expect(active?.path).toBe("/b.ts");

    useEditorStore.setState({ activePath: null });
    expect(getActiveDoc(useEditorStore.getState())).toBeNull();
  });
});
