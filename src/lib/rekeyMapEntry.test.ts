import { describe, expect, it, vi } from "vitest";
import { reconcileMapMove, rekeyMapEntry } from "./rekeyMapEntry";

describe("rekeyMapEntry", () => {
  it("disposes a destination collision before replacing its map entry", () => {
    const source = { id: "source" };
    const destination = { id: "destination" };
    const models = new Map([
      ["/source.ts", source],
      ["/destination.ts", destination],
    ]);
    const dispose = vi.fn();

    expect(
      rekeyMapEntry(models, "/source.ts", "/destination.ts", dispose),
    ).toBe(true);

    expect(dispose).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledWith(destination);
    expect(models).toEqual(new Map([["/destination.ts", source]]));
  });

  it("does not mutate the map when the source key is absent", () => {
    const destination = { id: "destination" };
    const models = new Map([["/destination.ts", destination]]);
    const dispose = vi.fn();

    expect(rekeyMapEntry(models, "/missing.ts", "/destination.ts", dispose)).toBe(
      false,
    );
    expect(dispose).not.toHaveBeenCalled();
    expect(models.get("/destination.ts")).toBe(destination);
  });
});

describe("reconcileMapMove", () => {
  interface ModelStub {
    id: string;
    disposed: boolean;
    language: string;
  }

  const usableMarkdown = (model: ModelStub) =>
    !model.disposed && model.language === "markdown";

  it("keeps the normal re-key behavior for a usable source", () => {
    const source: ModelStub = {
      id: "source",
      disposed: false,
      language: "markdown",
    };
    const destination: ModelStub = {
      id: "destination",
      disposed: false,
      language: "markdown",
    };
    const models = new Map([
      ["/source.md", source],
      ["/destination.md", destination],
    ]);
    const dispose = vi.fn();

    expect(
      reconcileMapMove(
        models,
        "/source.md",
        "/destination.md",
        usableMarkdown,
        dispose,
      ),
    ).toBe(source);

    expect(dispose).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledWith(destination);
    expect(models).toEqual(new Map([["/destination.md", source]]));
  });

  it("disposes a stale destination when the source model is absent", () => {
    const destination: ModelStub = {
      id: "destination",
      disposed: false,
      language: "markdown",
    };
    const models = new Map([["/destination.md", destination]]);
    const dispose = vi.fn();

    expect(
      reconcileMapMove(
        models,
        "/missing.md",
        "/destination.md",
        usableMarkdown,
        dispose,
      ),
    ).toBeUndefined();

    expect(dispose).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledWith(destination);
    expect(models).toEqual(new Map());
  });

  it.each([
    {
      name: "disposed",
      source: { id: "source", disposed: true, language: "markdown" },
    },
    {
      name: "language-mismatched",
      source: { id: "source", disposed: false, language: "plaintext" },
    },
  ])("disposes the stale destination for a $name source", ({ source }) => {
    const destination: ModelStub = {
      id: "destination",
      disposed: false,
      language: "markdown",
    };
    const models = new Map([
      ["/source.md", source],
      ["/destination.md", destination],
    ]);
    const dispose = vi.fn();

    expect(
      reconcileMapMove(
        models,
        "/source.md",
        "/destination.md",
        usableMarkdown,
        dispose,
      ),
    ).toBeUndefined();

    expect(dispose).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledWith(destination);
    expect(models).toEqual(new Map([["/source.md", source]]));
  });
});
