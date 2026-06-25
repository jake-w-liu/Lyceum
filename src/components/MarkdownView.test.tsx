import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MarkdownView } from "./MarkdownView";
import { initialEditorData, useEditorStore } from "../state/editorStore";

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

describe("MarkdownView", () => {
  beforeEach(() => {
    useEditorStore.setState(initialEditorData, false);
    clearCaretMock();
  });

  it("renders the document content as HTML", () => {
    useEditorStore.getState().openDoc({
      path: "/w/a.md",
      content: "# Title\n\nhello",
      language: "markdown",
    });
    const { container } = render(<MarkdownView path="/w/a.md" />);

    expect(container.querySelector("h1")?.textContent).toBe("Title");
    expect(container.textContent).toContain("hello");
  });

  it("renders a placeholder when the doc is not open", () => {
    const { container } = render(<MarkdownView path="/w/missing.md" />);

    expect(container.textContent).toContain(
      "Open the Markdown file to preview it.",
    );
  });

  it("reports the source position under the double-clicked text", () => {
    useEditorStore.getState().openDoc({
      path: "/w/a.md",
      content: "# Title\n\nhello **bold text** world",
      language: "markdown",
    });
    const onEditRequest = vi.fn();
    render(<MarkdownView path="/w/a.md" onEditRequest={onEditRequest} />);

    const bold = screen.getByText("bold text");
    const textNode = bold.firstChild;
    expect(textNode).toBeInstanceOf(Text);
    mockCaretAt(textNode as Text, 2);

    fireEvent.doubleClick(bold, { clientX: 10, clientY: 20 });

    expect(onEditRequest).toHaveBeenCalledWith({ line: 3, column: 11 });
  });
});
