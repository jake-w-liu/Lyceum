// Derive the output PDF name from a build command or active .tex path.
export function deriveOutputPdf(
  buildCommand: string,
  activeTexPath: string | null,
): string | null {
  const tokens = buildCommand.split(/\s+/).filter(Boolean);
  let lastTex: string | null = null;
  for (const token of tokens) {
    if (token.toLowerCase().endsWith(".tex")) {
      lastTex = token;
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

// Take the basename and swap the trailing .tex (any case) for .pdf.
function toPdfBasename(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? path;
  return base.replace(/\.tex$/i, ".pdf");
}
