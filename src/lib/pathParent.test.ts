import { describe, expect, it } from "vitest";
import {
  parentDirectory,
  parentDirectoryForTraversal,
} from "./pathParent";

describe("parentDirectory", () => {
  it("preserves both forms of a Windows drive root", () => {
    expect(parentDirectory("C:\\file.txt")).toBe("C:\\");
    expect(parentDirectory("C:/file.txt")).toBe("C:/");
    expect(parentDirectory("C:\\")).toBe("C:\\");
    expect(parentDirectory("C:/")).toBe("C:/");
  });

  it("returns nested Windows parents without changing separators", () => {
    expect(parentDirectory("C:\\work\\src\\file.ts")).toBe("C:\\work\\src");
    expect(parentDirectory("C:/work/src/file.ts")).toBe("C:/work/src");
  });

  it("preserves the POSIX root", () => {
    expect(parentDirectory("/file.txt")).toBe("/");
    expect(parentDirectory("/")).toBe("/");
    expect(parentDirectory("/work/src/file.ts")).toBe("/work/src");
  });

  it("stops at UNC share roots instead of descending to a server", () => {
    const root = "\\\\server\\share";
    expect(parentDirectory(`${root}\\file.txt`)).toBe(root);
    expect(parentDirectory(root)).toBe(root);
    expect(parentDirectory(`${root}\\`)).toBe(`${root}\\`);
    expect(parentDirectoryForTraversal(root)).toBe("");
    expect(parentDirectoryForTraversal(`${root}\\`)).toBe("");
  });

  it("supports forward-slash and extended Windows UNC roots", () => {
    expect(parentDirectory("//server/share/file.txt")).toBe("//server/share");
    expect(parentDirectory("\\\\?\\UNC\\server\\share\\file.txt")).toBe(
      "\\\\?\\UNC\\server\\share",
    );
    expect(parentDirectory("\\\\?\\C:\\file.txt")).toBe("\\\\?\\C:\\");
  });

  it("returns an empty parent for relative leaf paths", () => {
    expect(parentDirectory("file.txt")).toBe("");
    expect(parentDirectoryForTraversal("file.txt")).toBe("");
  });
});
