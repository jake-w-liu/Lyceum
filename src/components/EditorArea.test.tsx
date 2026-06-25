import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { EditorArea } from "./EditorArea";
import { initialEditorData, useEditorStore } from "../state/editorStore";
import { initialLayoutData, useLayoutStore } from "../state/layoutStore";

function mockCaretAt(node: Node, offset: number): void {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  Object.defineProperty(document, "caretRangeFromPoint", {
    configurable: true,
    writable: true,
    value: vi.fn(() => range),
  });
}

function clearCaretMock(): void {
  Object.defineProperty(document, "caretRangeFromPoint", {
    configurable: true,
    writable: true,
    value: undefined,
  });
}

vi.mock("./MonacoEditor", () => ({
  default: () => <div data-testid="monaco-editor" />,
}));
vi.mock("./PdfViewer", () => ({
  default: ({ path }: { path: string }) => (
    <div data-testid="pdf-viewer">{path}</div>
  ),
}));
vi.mock("./ImageViewer", () => ({
  ImageViewer: ({ path }: { path: string }) => (
    <div data-testid="image-viewer">{path}</div>
  ),
}));

describe("EditorArea", () => {
  beforeEach(() => {
    useEditorStore.setState(initialEditorData, false);
    useLayoutStore.setState(initialLayoutData, false);
    clearCaretMock();
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

  it("switches Markdown preview back to source editing at the double-clicked position", async () => {
    useEditorStore.getState().openDoc({
      path: "/w/notes.md",
      content: "# Notes",
      language: "markdown",
    });
    useLayoutStore.getState().setEditorPreview(true);

    render(<EditorArea />);

    expect(await screen.findByLabelText("Markdown preview")).toBeInTheDocument();
    const heading = await screen.findByText("Notes");
    const textNode = heading.firstChild;
    expect(textNode).toBeInstanceOf(Text);
    mockCaretAt(textNode as Text, 3);

    fireEvent.doubleClick(heading, { clientX: 10, clientY: 20 });

    await waitFor(() =>
      expect(useLayoutStore.getState().editorPreview).toBe(false),
    );
    expect(useEditorStore.getState().pendingReveal).toEqual({
      path: "/w/notes.md",
      line: 1,
      column: 6,
    });
  });

  it("renders PDF viewer tabs in the editor area", async () => {
    useEditorStore.getState().openDoc({
      path: "/w/paper.pdf",
      content: "",
      language: "pdf",
      kind: "pdf",
    });

    render(<EditorArea />);

    expect(screen.getByRole("tab", { name: "paper.pdf" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.queryByTestId("monaco-editor")).not.toBeInTheDocument();
    expect(await screen.findByLabelText("PDF preview")).toBeInTheDocument();
    expect(await screen.findByTestId("pdf-viewer")).toHaveTextContent(
      "/w/paper.pdf",
    );
  });

  it("renders image viewer tabs in the editor area", async () => {
    useEditorStore.getState().openDoc({
      path: "/w/icon.png",
      content: "",
      language: "image",
      kind: "image",
    });

    render(<EditorArea />);

    expect(screen.getByRole("tab", { name: "icon.png" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(await screen.findByLabelText("Image preview")).toBeInTheDocument();
    expect(await screen.findByTestId("image-viewer")).toHaveTextContent(
      "/w/icon.png",
    );
  });
});
