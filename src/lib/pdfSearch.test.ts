import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPageIndex,
  findMatches,
  matchRectsInElement,
  MAX_PDF_MATCHES,
} from "./pdfSearch";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildPageIndex", () => {
  it("concatenates and lowercases item text, ignoring non-text markers", () => {
    const index = buildPageIndex(3, {
      items: [{ str: "Hello " }, { type: "beginMarkedContent" }, { str: "World" }],
    });
    expect(index).toEqual({ pageNumber: 3, lower: "hello world" });
  });
});

describe("findMatches", () => {
  const index = [
    buildPageIndex(1, { items: [{ str: "alpha beta alpha" }] }),
    buildPageIndex(2, { items: [{ str: "ALPHA gamma" }] }),
  ];

  it("returns nothing for an empty query", () => {
    expect(findMatches(index, "")).toEqual([]);
  });

  it("finds case-insensitive matches in reading order with per-page ordinals", () => {
    expect(findMatches(index, "alpha")).toEqual([
      { pageNumber: 1, occurrence: 0 },
      { pageNumber: 1, occurrence: 1 },
      { pageNumber: 2, occurrence: 0 },
    ]);
  });

  it("counts repeated runs as non-overlapping matches", () => {
    const i = [buildPageIndex(1, { items: [{ str: "aaaa" }] })];
    expect(findMatches(i, "aa")).toEqual([
      { pageNumber: 1, occurrence: 0 },
      { pageNumber: 1, occurrence: 1 },
    ]);
  });

  it("caps the result set to bound memory on pathological queries", () => {
    const i = [buildPageIndex(1, { items: [{ str: "a".repeat(5000) }] })];
    expect(findMatches(i, "a").length).toBe(MAX_PDF_MATCHES);
    expect(findMatches(i, "a", 10).length).toBe(10);
  });
});

describe("matchRectsInElement", () => {
  function container(html: string): HTMLDivElement {
    const el = document.createElement("div");
    el.innerHTML = html;
    return el;
  }

  it("returns [] for an empty or absent query", () => {
    const el = container("<span>hello</span><span>world</span>");
    expect(matchRectsInElement(el, "", 0)).toEqual([]);
    expect(matchRectsInElement(el, "zzz", 0)).toEqual([]);
  });

  it("ranges over the right node/offset for the requested occurrence across spans", () => {
    const el = container("<span>foo bar </span><span>baz bar</span>");
    const setStart = vi.fn();
    const setEnd = vi.fn();
    const rect = { left: 1, top: 2, width: 3, height: 4 } as DOMRect;
    vi.spyOn(document, "createRange").mockReturnValue({
      setStart,
      setEnd,
      getClientRects: () => [rect] as unknown as DOMRectList,
    } as unknown as Range);

    // Flat text "foo bar baz bar": occurrence 1 is the second "bar" (offset 12),
    // which lands in the 2nd text node at chars 4..7.
    const rects = matchRectsInElement(el, "BAR", 1);

    expect(rects).toEqual([rect]);
    expect((setStart.mock.calls[0][0] as Text).data).toBe("baz bar");
    expect(setStart.mock.calls[0][1]).toBe(4);
    expect(setEnd.mock.calls[0][1]).toBe(7);
  });
});
