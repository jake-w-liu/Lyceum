// Shared path-based file type helpers. These are intentionally extension-based:
// the app only has a path at routing time, and the backend still reads the
// actual bytes when a preview component mounts.

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpe: "image/jpeg",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
};

export function extensionForPath(path: string): string {
  const filename = path.split(/[\\/]/).pop() ?? path;
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

export function isMarkdownPath(path: string): boolean {
  const ext = extensionForPath(path);
  return ext === "md" || ext === "markdown";
}

export function isHtmlPath(path: string): boolean {
  const ext = extensionForPath(path);
  return ext === "html" || ext === "htm";
}

export function isInlinePreviewPath(path: string): boolean {
  return isMarkdownPath(path) || isHtmlPath(path);
}

export function isPdfPath(path: string): boolean {
  return extensionForPath(path) === "pdf";
}

export function isTexSourcePath(path: string): boolean {
  return extensionForPath(path) === "tex";
}

export function isJuliaSourcePath(path: string): boolean {
  return extensionForPath(path) === "jl";
}

export function imageMimeForPath(path: string): string | null {
  return IMAGE_MIME_BY_EXTENSION[extensionForPath(path)] ?? null;
}

export function isImagePath(path: string): boolean {
  return imageMimeForPath(path) !== null;
}

/** The last path segment (file or folder name). */
export function baseNameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() ?? trimmed;
}

/**
 * Path of `abs` relative to workspace `root` (forward slashes, no leading sep).
 * Returns the bare name when `abs` is the root itself, and the absolute path
 * unchanged when it lies outside the root.
 */
export function relativePath(root: string, abs: string): string {
  if (!root) return abs;
  const sep = root.includes("\\") ? "\\" : "/";
  const normRoot = root.endsWith(sep) ? root.slice(0, -1) : root;
  if (abs === normRoot) return baseNameOf(normRoot);
  const prefix = normRoot + sep;
  if (abs.startsWith(prefix)) {
    return abs.slice(prefix.length).replace(/\\/g, "/");
  }
  return abs;
}
