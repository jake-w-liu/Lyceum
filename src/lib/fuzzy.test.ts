// Tests for fuzzy subsequence matching utilities.

import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyMatch, fuzzyScore } from "./fuzzy";

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

describe("fuzzyScore", () => {
  it("does not award the contiguity bonus to the first matched character", () => {
    // 'a' matches at index 0: 1 (base) + 5 (start) = 6. The first character has
    // no predecessor, so the +3 contiguity bonus must NOT apply (it returned 9
    // before, because the -1 sentinel collided with `ti - 1` at ti === 0).
    expect(fuzzyScore("a", "abc")).toBe(6);
  });

  it("awards the contiguity bonus only to genuinely adjacent matches", () => {
    // "ab" at indices 0,1: 1+5 (a) + 1+3 (b, contiguous) = 10.
    expect(fuzzyScore("ab", "abc")).toBe(10);
    // "ac" at indices 0,2: 1+5 (a) + 1 (c, not contiguous) = 7.
    expect(fuzzyScore("ac", "abc")).toBe(7);
  });
});
