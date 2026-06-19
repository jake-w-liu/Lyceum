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

  it("canonicalizes Greek final sigma so the index matches the query fold", () => {
    // "ΛΟΓΟΣ" alone lowercases to "λογος" (word-final ς); the page index folds it
    // to medial "λογοσ" so a query typed either way still matches.
    const index = [buildPageIndex(1, { items: [{ str: "ΛΟΓΟΣ" }] })];
    expect(index[0].lower).toBe("λογοσ");
    expect(findMatches(index, "λογοσ")).toEqual([
      { pageNumber: 1, occurrence: 0 },
    ]);
    expect(findMatches(index, "λογος")).toEqual([
      { pageNumber: 1, occurrence: 0 },
    ]);
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

  it("maps to original-node offsets when a char's lowercase changes UTF-16 length", () => {
    // "İz bar".toLowerCase() === "i̇z bar": İ (U+0130, 1 unit) lowercases to
    // "i" + combining dot (2 units), so the search index space is LONGER than the
    // original node text. The Range must still target the ORIGINAL offsets of
    // "bar" (3..6); the pre-fix code mapped through original lengths and landed on
    // the wrong offset (or returned [] when the end offset overran the node).
    const el = container("<span>İz bar</span>");
    const setStart = vi.fn();
    const setEnd = vi.fn();
    const rect = { left: 1, top: 2, width: 3, height: 4 } as DOMRect;
    vi.spyOn(document, "createRange").mockReturnValue({
      setStart,
      setEnd,
      getClientRects: () => [rect] as unknown as DOMRectList,
    } as unknown as Range);

    const rects = matchRectsInElement(el, "bar", 0);

    expect(rects).toEqual([rect]);
    expect((setStart.mock.calls[0][0] as Text).data).toBe("İz bar");
    expect(setStart.mock.calls[0][1]).toBe(3);
    expect((setEnd.mock.calls[0][0] as Text).data).toBe("İz bar");
    expect(setEnd.mock.calls[0][1]).toBe(6);
  });

  it("folds final sigma so a match across a Σ text-item boundary still highlights", () => {
    // pdf.js can split a word into separate spans. "ΟΔΟΣ" ending a node makes its
    // Σ lowercase to word-final ς, while the page index sees medial σ. Without
    // canonicalizing ς->σ the per-node search space ("οδοςμου") diverges from the
    // query ("οσμ") and the highlight crossing the boundary is dropped.
    const el = container("<span>ΟΔΟΣ</span><span>ΜΟΥ</span>");
    const setStart = vi.fn();
    const setEnd = vi.fn();
    const rect = { left: 1, top: 2, width: 3, height: 4 } as DOMRect;
    vi.spyOn(document, "createRange").mockReturnValue({
      setStart,
      setEnd,
      getClientRects: () => [rect] as unknown as DOMRectList,
    } as unknown as Range);

    const rects = matchRectsInElement(el, "οσμ", 0);

    expect(rects).toEqual([rect]);
    expect((setStart.mock.calls[0][0] as Text).data).toBe("ΟΔΟΣ");
    expect(setStart.mock.calls[0][1]).toBe(2);
    expect((setEnd.mock.calls[0][0] as Text).data).toBe("ΜΟΥ");
    expect(setEnd.mock.calls[0][1]).toBe(1);
  });
});
