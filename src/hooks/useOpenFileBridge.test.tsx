import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";

vi.mock("../lib/ipc", () => ({ readFile: vi.fn(async () => "file contents") }));
import { readFile } from "../lib/ipc";
import { initialEditorData, useEditorStore } from "../state/editorStore";
import {
  initialWorkspaceData,
  useWorkspaceStore,
} from "../state/workspaceStore";
import { useOpenFileBridge } from "./useOpenFileBridge";

function Harness() {
  useOpenFileBridge();
  return null;
}

beforeEach(() => {
  useWorkspaceStore.setState(initialWorkspaceData, false);
  useEditorStore.setState(initialEditorData, false);
  vi.mocked(readFile).mockClear();
});

describe("useOpenFileBridge", () => {
  it("opens the pending file in the editor and clears the intent", async () => {
    render(<Harness />);
    act(() => {
      useWorkspaceStore.getState().requestOpenFile("/w/main.py");
    });

    await waitFor(() => {
      expect(useEditorStore.getState().docs).toHaveLength(1);
    });

    const doc = useEditorStore.getState().docs[0];
    expect(doc.path).toBe("/w/main.py");
    expect(doc.content).toBe("file contents");
    expect(doc.language).toBe("python");
    expect(readFile).toHaveBeenCalledWith("/w/main.py");
    expect(useWorkspaceStore.getState().pendingOpenPath).toBeNull();
  });
});
