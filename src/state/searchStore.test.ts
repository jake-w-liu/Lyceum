import { beforeEach, describe, expect, it } from "vitest";
import {
  type SearchMatch,
  initialSearchData,
  useSearchStore,
} from "./searchStore";

const get = () => useSearchStore.getState();

beforeEach(() => useSearchStore.setState(initialSearchData, false));

describe("searchStore", () => {
  it("updates the query slice", () => {
    get().setQuery("needle");
    expect(get().query).toBe("needle");
  });

  it("updates the results slice", () => {
    const results: SearchMatch[] = [
      { path: "src/a.ts", line: 1, column: 4, text: "needle" },
      { path: "src/b.ts", line: 9, column: 0, text: "more needle" },
    ];
    get().setResults(results);
    expect(get().results).toEqual(results);
  });

  it("updates the searching slice", () => {
    get().setSearching(true);
    expect(get().searching).toBe(true);
    get().setSearching(false);
    expect(get().searching).toBe(false);
  });

  it("clear() resets query, results, and searching", () => {
    get().setQuery("needle");
    get().setResults([{ path: "src/a.ts", line: 1, column: 4, text: "needle" }]);
    get().setSearching(true);
    get().clear();
    expect(get().query).toBe("");
    expect(get().results).toEqual([]);
    expect(get().searching).toBe(false);
  });
});
