import { describe, expect, it } from "vitest";
import { buildInitializeParams, pathToUri, uriToPath } from "./lspProtocol";

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
});
