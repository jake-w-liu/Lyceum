// Derive and select LaTeX build commands for the active .tex path.

export const STOCK_LATEX_BUILD_COMMAND = "latexmk -pdf main.tex";

type LatexTool = "latexmk" | "tectonic" | "pdflatex" | "xelatex" | "lualatex";

export const LATEX_TOOL_ORDER: LatexTool[] = [
  "latexmk",
  "tectonic",
  "pdflatex",
  "xelatex",
  "lualatex",
];

export function shouldAutoSelectLatexTool(buildCommand: string): boolean {
  return canonicalShellCommand(buildCommand) === STOCK_LATEX_BUILD_COMMAND;
}

export function buildCommandForTexTool(tool: LatexTool, texPath: string): string {
  const texArg = quoteShellArg(baseName(texPath));
  switch (tool) {
    case "latexmk":
      return `latexmk -pdf ${texArg}`;
    case "tectonic":
      return `tectonic ${texArg}`;
    case "pdflatex":
    case "xelatex":
    case "lualatex":
      return `${tool} -interaction=nonstopmode -halt-on-error ${texArg}`;
  }
}

export function selectLatexBuildCommand(
  configuredCommand: string,
  texPath: string,
  availableTools: readonly string[],
): string {
  if (!shouldAutoSelectLatexTool(configuredCommand)) {
    return buildCommandForTexPath(configuredCommand, texPath);
  }
  const selected = LATEX_TOOL_ORDER.find((tool) =>
    availableTools.includes(tool),
  );
  return selected
    ? buildCommandForTexTool(selected, texPath)
    : buildCommandForTexPath(configuredCommand, texPath);
}

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

export function buildCommandForTexPath(
  buildCommand: string,
  texPath: string,
): string {
  const texArg = quoteShellArg(baseName(texPath));
  const tokens = buildCommand.split(/\s+/).filter(Boolean);
  let lastTexIndex = -1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (stripShellQuotes(tokens[i]).toLowerCase().endsWith(".tex")) {
      lastTexIndex = i;
      break;
    }
  }
  if (lastTexIndex >= 0) {
    tokens[lastTexIndex] = texArg;
    return tokens.join(" ");
  }
  return [...tokens, texArg].join(" ");
}

export function pdfPathForTexPath(texPath: string): string {
  const dir = parentDir(texPath);
  const pdfName = toPdfBasename(texPath);
  return dir ? joinPath(dir, pdfName, texPath) : pdfName;
}

export function texBuildDirectory(texPath: string): string | null {
  return parentDir(texPath) || null;
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

function quoteShellArg(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function normalizeShellWhitespace(command: string): string {
  return command.trim().split(/\s+/).join(" ");
}

function canonicalShellCommand(command: string): string {
  return normalizeShellWhitespace(command)
    .split(/\s+/)
    .map(stripShellQuotes)
    .join(" ");
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
