import { describe, expect, it } from "vitest";
import {
  buildInitializeParams,
  leafName,
  pathToUri,
  uriToPath,
} from "./lspProtocol";

describe("lsp protocol helpers", () => {
  it("converts a path to a file URI and back", () => {
    expect(pathToUri("/Users/jake/a b/main.jl")).toBe(
      "file:///Users/jake/a%20b/main.jl",
    );
    expect(uriToPath("file:///Users/jake/a%20b/main.jl")).toBe(
      "/Users/jake/a b/main.jl",
    );
  });

  it("ensures a leading slash", () => {
    expect(pathToUri("rel/x.jl")).toBe("file:///rel/x.jl");
  });

  it("builds initialize params with a rootUri and workspace folder", () => {
    const params = buildInitializeParams("/w/proj");
    expect(params.rootUri).toBe("file:///w/proj");
    expect(params.workspaceFolders).toEqual([
      { uri: "file:///w/proj", name: "proj" },
    ]);
    expect(params.processId).toBeNull();
  });

  it("allows a null root", () => {
    const params = buildInitializeParams(null);
    expect(params.rootUri).toBeNull();
    expect(params.workspaceFolders).toBeNull();
  });

  it("derives the workspace-folder name as the leaf for posix and windows roots", () => {
    expect(leafName("/Users/jake/proj")).toBe("proj");
    expect(leafName("/Users/jake/proj/")).toBe("proj"); // trailing separator
    expect(leafName("C:\\Users\\jake\\proj")).toBe("proj"); // windows backslash
    expect(leafName("\\\\?\\C:\\Users\\jake\\proj")).toBe("proj"); // \\?\ prefix
    expect(buildInitializeParams("C:\\Users\\jake\\proj").workspaceFolders).toEqual(
      [{ uri: pathToUri("C:\\Users\\jake\\proj"), name: "proj" }],
    );
  });

  it("falls back to the raw form on malformed percent-encoding (never throws)", () => {
    // A lone '%' is invalid for decodeURIComponent; uriToPath must not throw out
    // of the diagnostics dispatch.
    expect(() => uriToPath("file:///bad/%ZZ/x")).not.toThrow();
    expect(uriToPath("file:///bad/%ZZ/x")).toBe("/bad/%ZZ/x");
  });
});
