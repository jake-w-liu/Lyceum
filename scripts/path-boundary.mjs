import { isAbsolute, relative, resolve, sep } from "node:path";

/** True only when candidate is a descendant of parent, never parent itself. */
export function isPathInside(parent, candidate) {
  const pathFromParent = relative(resolve(parent), resolve(candidate));
  return (
    pathFromParent.length > 0 &&
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  );
}
