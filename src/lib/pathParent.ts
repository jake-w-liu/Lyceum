function isSeparator(character: string | undefined): boolean {
  return character === "/" || character === "\\";
}

function isAsciiLetter(character: string | undefined): boolean {
  if (!character) return false;
  const code = character.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isDriveRootAt(path: string, offset: number): boolean {
  return (
    isAsciiLetter(path[offset]) &&
    path[offset + 1] === ":" &&
    isSeparator(path[offset + 2])
  );
}

function segmentEnd(path: string, start: number): number {
  let end = start;
  while (end < path.length && !isSeparator(path[end])) end += 1;
  return end;
}

/** Return the exclusive end of a UNC share root, or zero if it is incomplete. */
function uncShareRootEnd(path: string, serverStart: number): number {
  const serverEnd = segmentEnd(path, serverStart);
  if (serverEnd === serverStart || !isSeparator(path[serverEnd])) return 0;

  const shareStart = serverEnd + 1;
  const shareEnd = segmentEnd(path, shareStart);
  return shareEnd === shareStart ? 0 : shareEnd;
}

/**
 * Return the exclusive end of an absolute filesystem root. Drive roots include
 * their separator ("C:\\"), while UNC roots end after the share name.
 */
function filesystemRootEnd(path: string): number {
  if (isDriveRootAt(path, 0)) return 3;
  if (!isSeparator(path[0])) return 0;
  if (!isSeparator(path[1])) return 1;

  // Windows extended paths: \\?\C:\... and \\?\UNC\server\share\...
  if ((path[2] === "?" || path[2] === ".") && isSeparator(path[3])) {
    if (isDriveRootAt(path, 4)) return 7;
    if (
      path.slice(4, 7).toUpperCase() === "UNC" &&
      isSeparator(path[7])
    ) {
      const extendedUncEnd = uncShareRootEnd(path, 8);
      if (extendedUncEnd > 0) return extendedUncEnd;
    }
  }

  // Both backslashes and forward slashes are valid Windows path separators.
  return uncShareRootEnd(path, 2) || 1;
}

function trimmedPathEnd(path: string, rootEnd: number): number {
  let end = path.length;
  while (end > rootEnd && isSeparator(path[end - 1])) end -= 1;
  return end;
}

function isFilesystemRoot(path: string): boolean {
  const rootEnd = filesystemRootEnd(path);
  return rootEnd > 0 && trimmedPathEnd(path, rootEnd) === rootEnd;
}

/**
 * Return a path's lexical parent while preserving its separator spelling.
 * Filesystem roots are stable: their parent is the same root.
 */
export function parentDirectory(path: string): string {
  const rootEnd = filesystemRootEnd(path);
  const end = trimmedPathEnd(path, rootEnd);
  if (rootEnd > 0 && end === rootEnd) return path;

  let separatorIndex = end - 1;
  while (separatorIndex >= 0 && !isSeparator(path[separatorIndex])) {
    separatorIndex -= 1;
  }
  if (separatorIndex < 0) return "";
  if (rootEnd > 0 && separatorIndex < rootEnd) {
    return path.slice(0, rootEnd);
  }
  return path.slice(0, separatorIndex);
}

/** Return a lexical parent, but use "" after reaching a filesystem root. */
export function parentDirectoryForTraversal(path: string): string {
  return isFilesystemRoot(path) ? "" : parentDirectory(path);
}
