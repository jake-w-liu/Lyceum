// Live Markdown preview of an open editor document. Subscribes only to the
// document's content (a primitive), debounces re-parsing, and memoizes the
// render so a burst of typing doesn't re-run markdown-it on every keystroke.

import { useEffect, useMemo, useState } from "react";
import { useEditorStore } from "../state/editorStore";
import { renderMarkdown } from "../lib/markdown";

const RENDER_DEBOUNCE_MS = 150;

export interface MarkdownSourcePosition {
  line: number;
  column: number;
}

interface CaretPositionResult {
  offsetNode: Node;
  offset: number;
}

type CaretDocument = Document & {
  caretPositionFromPoint?: (
    x: number,
    y: number,
  ) => CaretPositionResult | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

async function openExternalHref(href: string): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(href);
  } catch {
    // Not inside Tauri (dev/test) or the open failed — blocking the in-app
    // navigation above is the important part; nothing else to do.
  }
}

/**
 * Stop preview links from navigating the privileged app WebView. In-page anchors
 * (#...) are left alone; http/https/mailto links open in the system browser.
 */
function handlePreviewClick(e: React.MouseEvent): void {
  const anchor = (e.target as HTMLElement | null)?.closest?.("a");
  if (!anchor) return;
  const href = anchor.getAttribute("href");
  if (!href || href.startsWith("#")) return;
  e.preventDefault();
  if (/^(https?:|mailto:)/i.test(href)) void openExternalHref(href);
}

function parentElement(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE
    ? (node as Element)
    : node.parentElement;
}

function sourceIndexFromCaret(
  root: HTMLElement,
  node: Node,
  offset: number,
): number | null {
  const sourceElement = parentElement(node)?.closest<HTMLElement>(
    "[data-source-index]",
  );
  if (!sourceElement || !root.contains(sourceElement)) return null;

  const sourceIndex = Number(sourceElement.dataset.sourceIndex);
  if (!Number.isFinite(sourceIndex)) return null;

  const range = root.ownerDocument.createRange();
  range.selectNodeContents(sourceElement);
  try {
    range.setEnd(node, offset);
  } catch {
    return sourceIndex;
  }
  return sourceIndex + range.toString().length;
}

function caretSourceIndexFromPoint(
  root: HTMLElement,
  x: number,
  y: number,
): number | null {
  const doc = root.ownerDocument as CaretDocument;
  const position = doc.caretPositionFromPoint?.(x, y);
  if (position) {
    return sourceIndexFromCaret(root, position.offsetNode, position.offset);
  }

  const range = doc.caretRangeFromPoint?.(x, y);
  if (!range) return null;
  return sourceIndexFromCaret(root, range.startContainer, range.startOffset);
}

function sourcePositionFromIndex(
  content: string,
  sourceIndex: number,
): MarkdownSourcePosition {
  const index = Math.max(0, Math.min(sourceIndex, content.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < index; i += 1) {
    if (content.charCodeAt(i) !== 10) continue;
    line += 1;
    lineStart = i + 1;
  }
  return { line, column: index - lineStart + 1 };
}

function fallbackBlockPosition(
  root: HTMLElement,
  target: EventTarget | null,
): MarkdownSourcePosition | undefined {
  if (!(target instanceof Element)) return undefined;
  const block = target.closest<HTMLElement>("[data-source-line]");
  if (!block || !root.contains(block)) return undefined;

  const line = Number(block.dataset.sourceLine);
  if (!Number.isFinite(line) || line < 1) return undefined;
  return { line, column: 1 };
}

function sourcePositionForDoubleClick(
  event: React.MouseEvent<HTMLElement>,
  content: string,
): MarkdownSourcePosition | undefined {
  const root = event.currentTarget;
  const sourceIndex = caretSourceIndexFromPoint(
    root,
    event.clientX,
    event.clientY,
  );
  if (sourceIndex !== null) return sourcePositionFromIndex(content, sourceIndex);
  return fallbackBlockPosition(root, event.target);
}

export function MarkdownView({
  path,
  onEditRequest,
}: {
  path: string;
  onEditRequest?: (position?: MarkdownSourcePosition) => void;
}) {
  const content = useEditorStore(
    (s) => s.docs.find((d) => d.path === path)?.content,
  );

  const [debounced, setDebounced] = useState(content ?? "");
  useEffect(() => {
    if (content === undefined) return;
    const timer = setTimeout(() => setDebounced(content), RENDER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [content]);

  const html = useMemo(() => renderMarkdown(debounced), [debounced]);

  function handleDoubleClick(event: React.MouseEvent<HTMLElement>): void {
    onEditRequest?.(
      content === undefined
        ? undefined
        : sourcePositionForDoubleClick(event, content),
    );
  }

  if (content === undefined) {
    return (
      <div className="markdown-preview" onDoubleClick={handleDoubleClick}>
        <p className="placeholder">Open the Markdown file to preview it.</p>
      </div>
    );
  }
  return (
    <div
      className="markdown-preview"
      onClickCapture={handlePreviewClick}
      onDoubleClick={handleDoubleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
