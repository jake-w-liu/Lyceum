// Resolve the working directory for a new terminal session.
export function resolveTerminalCwd(
  behavior: "workspaceRoot" | "currentFileDir",
  rootPath: string | null,
  activeFilePath: string | null,
): string | null {
  if (behavior === "currentFileDir" && activeFilePath) {
    // Handle both POSIX and Windows separators.
    const idx = Math.max(
      activeFilePath.lastIndexOf("/"),
      activeFilePath.lastIndexOf("\\"),
    );
    if (idx > 0) return activeFilePath.slice(0, idx); // parent directory
    if (idx === 0) return activeFilePath.slice(0, 1); // file at filesystem root
    return rootPath; // bare filename (no directory component)
  }
  return rootPath;
}
