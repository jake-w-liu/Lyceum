// LSP server configurations and selectors.

export interface LspServerConfig {
  id: string;
  languageId: string;
  fileExtensions: string[];
  rootMarkers: string[];
  build: (opts: { juliaPath?: string | null }) => { cmd: string; args: string[] };
}

export const LSP_SERVERS: LspServerConfig[] = [
  {
    id: "julia",
    languageId: "julia",
    fileExtensions: ["jl"],
    rootMarkers: ["Project.toml", "JuliaProject.toml"],
    build: (o) => ({
      cmd: o.juliaPath && o.juliaPath.length > 0 ? o.juliaPath : "julia",
      args: [
        "--startup-file=no",
        "--history-file=no",
        "-e",
        "using LanguageServer; runserver()",
      ],
    }),
  },
  {
    id: "pyright",
    languageId: "python",
    fileExtensions: ["py"],
    rootMarkers: ["pyproject.toml", "setup.py", "requirements.txt"],
    build: () => ({ cmd: "pyright-langserver", args: ["--stdio"] }),
  },
  {
    id: "csharp",
    languageId: "csharp",
    fileExtensions: ["cs"],
    rootMarkers: [".sln", ".csproj"],
    build: () => ({ cmd: "csharp-ls", args: [] }),
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
