// Sandboxed rendered preview for open HTML documents. Scripts are allowed inside
// the iframe so ordinary HTML previews can run, but `allow-same-origin` is
// intentionally omitted so project HTML does not gain app/WebView powers.

import { useEffect, useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useEditorStore } from "../state/editorStore";
import { baseName, useWorkspaceStore } from "../state/workspaceStore";

const HTML_PREVIEW_SANDBOX = "allow-scripts allow-forms";
const RENDER_DEBOUNCE_MS = 150;

export function HtmlPreview({ path }: { path: string }) {
  const content = useEditorStore(
    (s) => s.docs.find((d) => d.path === path)?.content,
  );
  const rootPath = useWorkspaceStore((s) => s.rootPath);

  // Debounce the content + memoize the built document so a burst of typing
  // doesn't re-parse the HTML and fully reload the iframe on every keystroke.
  const [debounced, setDebounced] = useState(content);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(content), RENDER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [content]);

  const srcDoc = useMemo(
    () =>
      debounced === undefined
        ? ""
        : buildHtmlPreviewDocument(debounced, path, rootPath),
    [debounced, path, rootPath],
  );

  if (content === undefined) {
    return (
      <div className="html-preview html-preview-missing">
        <p className="placeholder">Open the HTML file to preview it.</p>
      </div>
    );
  }

  return (
    <iframe
      className="html-preview-frame"
      title={`${baseName(path)} preview`}
      sandbox={HTML_PREVIEW_SANDBOX}
      srcDoc={srcDoc}
    />
  );
}

export function buildHtmlPreviewDocument(
  content: string,
  path: string,
  workspaceRoot: string | null,
): string {
  if (typeof DOMParser === "undefined") {
    const base = previewBaseHref(path);
    return base ? `<base href="${escapeAttr(base)}">\n${content}` : content;
  }

  const doc = new DOMParser().parseFromString(content, "text/html");
  ensureBaseElement(doc, path);
  rewriteRootRelativeUrls(doc, workspaceRoot);
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

function ensureBaseElement(doc: Document, path: string): void {
  if (doc.head.querySelector("base")) return;
  const baseHref = previewBaseHref(path);
  if (!baseHref) return;
  const base = doc.createElement("base");
  base.href = baseHref;
  doc.head.prepend(base);
}

function previewBaseHref(path: string): string | null {
  const dir = parentDir(path);
  if (!dir) return null;
  return ensureTrailingSlash(fileAssetUrl(dir));
}

function rewriteRootRelativeUrls(
  doc: Document,
  workspaceRoot: string | null,
): void {
  if (!workspaceRoot) return;
  for (const attr of ["href", "src", "poster", "data"]) {
    for (const el of Array.from(doc.querySelectorAll(`[${attr}]`))) {
      const value = el.getAttribute(attr);
      if (value && isRootRelativeUrl(value)) {
        el.setAttribute(attr, fileAssetUrl(joinRootPath(workspaceRoot, value)));
      }
    }
  }
}

function isRootRelativeUrl(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//");
}

function parentDir(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(0, idx + 1) : "";
}

function joinRootPath(root: string, urlPath: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  const child = urlPath.replace(/^\/+/, "").replace(/\//g, sep);
  return root.endsWith(sep) ? `${root}${child}` : `${root}${sep}${child}`;
}

function fileAssetUrl(path: string): string {
  try {
    return convertFileSrc(path);
  } catch {
    return pathToFileUrl(path);
  }
}

function pathToFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const prefix = normalized.startsWith("/") ? "file://" : "file:///";
  return `${prefix}${encodeURI(normalized)}`;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
