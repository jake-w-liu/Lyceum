// Live Markdown preview of an open editor document. Subscribes only to the
// document's content (a primitive), debounces re-parsing, and memoizes the
// render so a burst of typing doesn't re-run markdown-it on every keystroke.

import { useEffect, useMemo, useState } from "react";
import { useEditorStore } from "../state/editorStore";
import { renderMarkdown } from "../lib/markdown";

const RENDER_DEBOUNCE_MS = 150;

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

export function MarkdownView({ path }: { path: string }) {
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

  if (content === undefined) {
    return (
      <div className="markdown-preview">
        <p className="placeholder">Open the Markdown file to preview it.</p>
      </div>
    );
  }
  return (
    <div
      className="markdown-preview"
      onClickCapture={handlePreviewClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
