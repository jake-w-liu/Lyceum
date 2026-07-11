// Resolve the working directory for a new terminal session.
import { parentDirectory } from "./pathParent";

export function resolveTerminalCwd(
  behavior: "workspaceRoot" | "currentFileDir",
  rootPath: string | null,
  activeFilePath: string | null,
): string | null {
  if (behavior === "currentFileDir" && activeFilePath) {
    return parentDirectory(activeFilePath) || rootPath;
  }
  return rootPath;
}
