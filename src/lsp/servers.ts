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
    id: "csharp",
    languageId: "csharp",
    fileExtensions: ["cs"],
    rootMarkers: [".sln", ".csproj"],
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
