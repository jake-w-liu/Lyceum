// Tests for fuzzy subsequence matching utilities.

import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyMatch } from "./fuzzy";

describe("fuzzyMatch", () => {
  it("matches an in-order subsequence", () => {
    expect(fuzzyMatch("ab", "axb")).toBe(true);
  });

  it("rejects an out-of-order query", () => {
    expect(fuzzyMatch("ba", "axb")).toBe(false);
  });

  it("treats an empty query as a match", () => {
    expect(fuzzyMatch("", "x")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(fuzzyMatch("AB", "axb")).toBe(true);
  });
});

describe("fuzzyFilter", () => {
  const key = (s: string) => s;

  it("returns all items for an empty/whitespace query", () => {
    const items = ["foo", "bar", "baz"];
    expect(fuzzyFilter(items, "", key)).toEqual(items);
    expect(fuzzyFilter(items, "   ", key)).toEqual(items);
  });

  it("filters out non-matching items", () => {
    const items = ["apple", "banana", "cherry"];
    expect(fuzzyFilter(items, "an", key)).toEqual(["banana"]);
  });

  it("sorts a prefix match before a scattered match", () => {
    const items = ["xaxbx", "abc"];
    expect(fuzzyFilter(items, "ab", key)).toEqual(["abc", "xaxbx"]);
  });
});
