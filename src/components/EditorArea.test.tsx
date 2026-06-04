import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { EditorArea } from "./EditorArea";
import { initialEditorData, useEditorStore } from "../state/editorStore";
import { initialLayoutData, useLayoutStore } from "../state/layoutStore";

vi.mock("./MonacoEditor", () => ({
  default: () => <div data-testid="monaco-editor" />,
}));

describe("EditorArea", () => {
  beforeEach(() => {
    useEditorStore.setState(initialEditorData, false);
    useLayoutStore.setState(initialLayoutData, false);
  });

  it("renders a sandboxed HTML preview overlay for active HTML documents", async () => {
    useEditorStore.getState().openDoc({
      path: "/w/index.html",
      content: "<h1>Hello</h1>",
      language: "html",
    });
    useLayoutStore.getState().setEditorPreview(true);

    render(<EditorArea />);

    expect(screen.getByLabelText("HTML preview")).toBeInTheDocument();
    const frame = await screen.findByTitle("index.html preview");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-forms");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
  });
});
