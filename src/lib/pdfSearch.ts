// Find-in-PDF helpers. The viewer builds a per-page text index from pdf.js text
// content (`buildPageIndex`) and locates case-insensitive matches across the
// whole document (`findMatches`). Highlight geometry is derived later from the
// rendered text layer (`matchRectsInElement`) rather than from text-item
// transforms, so it stays accurate under any zoom/rotation the browser applied.

/** Just enough of pdf.js `TextContent` to read item strings. Items are typed
 *  loosely (`unknown`) because the real array mixes text items with
 *  marked-content markers that carry no `str`; `buildPageIndex` guards for it. */
export interface PdfTextContent {
  items: readonly unknown[];
}

export interface PdfPageIndex {
  pageNumber: number;
  /** Lowercased concatenation of the page's text items, matching the order the
   *  text layer appends its spans so occurrence ordinals line up with the DOM. */
  lower: string;
}

export interface PdfMatch {
  pageNumber: number;
  /** Zero-based ordinal of this match among matches on its own page — used to
   *  re-locate it in the rendered text layer for highlighting. */
  occurrence: number;
}

export function buildPageIndex(
  pageNumber: number,
  content: PdfTextContent,
): PdfPageIndex {
  let text = "";
  for (const item of content.items) {
    const str = (item as { str?: unknown }).str;
    if (typeof str === "string") text += str;
  }
  return { pageNumber, lower: text.toLowerCase() };
}

/** Upper bound on collected matches. Caps the matches array and the highlight
 *  DOM nodes it drives, so a very common query (e.g. "e") over a large document
 *  can't blow up memory. Reaching it is surfaced in the UI as "N+". */
export const MAX_PDF_MATCHES = 1000;

/** Non-overlapping, case-insensitive matches of `rawQuery`, in reading order
 *  (page, then position), capped at `limit`. Returns [] for an empty query. */
export function findMatches(
  index: PdfPageIndex[],
  rawQuery: string,
  limit: number = MAX_PDF_MATCHES,
): PdfMatch[] {
  const query = rawQuery.toLowerCase();
  if (!query) return [];
  const matches: PdfMatch[] = [];
  for (const page of index) {
    let from = 0;
    let occurrence = 0;
    for (;;) {
      const at = page.lower.indexOf(query, from);
      if (at === -1) break;
      matches.push({ pageNumber: page.pageNumber, occurrence });
      occurrence += 1;
      from = at + query.length; // non-overlapping
      if (matches.length >= limit) return matches;
    }
  }
  return matches;
}

/**
 * Client rects for the `occurrence`-th case-insensitive match of `query` within
 * `container`'s rendered text. Walks the live text nodes (the same order pdf.js
 * appended its spans) and returns a Range's client rects — one per visual line
 * the match wraps. Empty array when the match isn't present (e.g. the page hasn't
 * rendered its text layer yet, or in jsdom where getClientRects is unavailable).
 */
export function matchRectsInElement(
  container: Node,
  query: string,
  occurrence: number,
): DOMRect[] {
  const q = query.toLowerCase();
  if (!q) return [];

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let flat = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    nodes.push(node);
    flat += node.data.toLowerCase();
  }

  // Skip to the requested occurrence (non-overlapping, matching findMatches).
  let from = 0;
  let start = -1;
  for (let i = 0; i <= occurrence; i += 1) {
    start = flat.indexOf(q, from);
    if (start === -1) return [];
    from = start + q.length;
  }
  const end = start + q.length;

  const locate = (pos: number): { node: Text; offset: number } | null => {
    let acc = 0;
    for (const node of nodes) {
      const len = node.data.length;
      if (pos <= acc + len) return { node, offset: pos - acc };
      acc += len;
    }
    return null;
  };
  const s = locate(start);
  const e = locate(end);
  if (!s || !e) return [];

  const range = document.createRange();
  range.setStart(s.node, s.offset);
  range.setEnd(e.node, e.offset);
  return Array.from(range.getClientRects());
}
