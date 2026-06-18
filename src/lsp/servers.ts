// LSP server configurations and selectors.

export interface LspServerConfig {
  id: string;
  languageId: string;
  fileExtensions: string[];
  rootMarkers: string[];
}

export const LSP_SERVERS: LspServerConfig[] = [
  {
    id: "julia",
    languageId: "julia",
    fileExtensions: ["jl"],
    rootMarkers: ["Project.toml", "JuliaProject.toml"],
  },
  {
    id: "pyright",
    languageId: "python",
    fileExtensions: ["py"],
    rootMarkers: ["pyproject.toml", "setup.py", "requirements.txt"],
  },
  {
    id: "typescript",
    languageId: "typescript",
    fileExtensions: ["ts", "tsx", "mts", "cts"],
    rootMarkers: ["tsconfig.json", "package.json"],
  },
  {
    id: "typescript",
    languageId: "javascript",
    fileExtensions: ["js", "jsx", "mjs", "cjs"],
    rootMarkers: ["jsconfig.json", "package.json"],
  },
  {
    id: "rust-analyzer",
    languageId: "rust",
    fileExtensions: ["rs"],
    rootMarkers: ["Cargo.toml"],
  },
  {
    id: "clangd",
    languageId: "c",
    fileExtensions: ["c", "h"],
    rootMarkers: ["compile_commands.json", "compile_flags.txt", ".clangd"],
  },
  {
    id: "clangd",
    languageId: "cpp",
    fileExtensions: ["cpp", "cc", "cxx", "hpp", "hh"],
    rootMarkers: ["compile_commands.json", "compile_flags.txt", ".clangd"],
  },
  {
    id: "gopls",
    languageId: "go",
    fileExtensions: ["go"],
    rootMarkers: ["go.mod", "go.work"],
  },
  {
    id: "csharp",
    languageId: "csharp",
    fileExtensions: ["cs"],
    rootMarkers: [".sln", ".csproj"],
  },
  {
    id: "r",
    languageId: "r",
    fileExtensions: ["r"],
    rootMarkers: ["DESCRIPTION", ".Rproj"],
  },
];

export function serverForLanguage(languageId: string): LspServerConfig | undefined {
  return LSP_SERVERS.find((s) => s.languageId === languageId);
}

export function serverForExtension(ext: string): LspServerConfig | undefined {
  const lower = ext.toLowerCase();
  return LSP_SERVERS.find((s) => s.fileExtensions.some((e) => e.toLowerCase() === lower));
}

export function serverForPath(path: string): LspServerConfig | undefined {
  const dot = path.lastIndexOf(".");
  if (dot < 0) {
    return undefined;
  }
  return serverForExtension(path.slice(dot + 1));
}
