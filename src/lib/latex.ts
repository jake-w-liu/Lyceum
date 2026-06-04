// Derive and select LaTeX build commands for the active .tex path.

export const STOCK_LATEX_BUILD_COMMAND = "latexmk -pdf main.tex";

export function deriveOutputPdf(
  buildCommand: string,
  activeTexPath: string | null,
): string | null {
  const tokens = buildCommand.split(/\s+/).filter(Boolean);
  let lastTex: string | null = null;
  for (const token of tokens) {
    const unquoted = stripShellQuotes(token);
    if (unquoted.toLowerCase().endsWith(".tex")) {
      lastTex = unquoted;
    }
  }
  if (lastTex) {
    return toPdfBasename(lastTex);
  }
  if (activeTexPath && activeTexPath.toLowerCase().endsWith(".tex")) {
    return toPdfBasename(activeTexPath);
  }
  return null;
}

export function pdfPathForTexPath(texPath: string): string {
  const dir = parentDir(texPath);
  const pdfName = toPdfBasename(texPath);
  return dir ? joinPath(dir, pdfName, texPath) : pdfName;
}

// Take the basename and swap the trailing .tex (any case) for .pdf.
function toPdfBasename(path: string): string {
  return baseName(path).replace(/\.tex$/i, ".pdf");
}

function baseName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

function parentDir(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (idx < 0) return "";
  if (idx === 0) return path.slice(0, 1);
  return path.slice(0, idx);
}

function pathSeparator(path: string): string {
  return path.includes("\\") ? "\\" : "/";
}

function joinPath(dir: string, name: string, originalPath: string): string {
  const sep = pathSeparator(originalPath);
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

function stripShellQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
