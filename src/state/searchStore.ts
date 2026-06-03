// Workspace-search UI state: the current query, its results, and whether a
// search is in flight.

import { create } from "zustand";

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface SearchData {
  query: string;
  results: SearchMatch[];
  searching: boolean;
}

export interface SearchActions {
  setQuery: (q: string) => void;
  setResults: (r: SearchMatch[]) => void;
  setSearching: (b: boolean) => void;
  clear: () => void;
}

export type SearchState = SearchData & SearchActions;

export const initialSearchData: SearchData = {
  query: "",
  results: [],
  searching: false,
};

export const useSearchStore = create<SearchState>()((set) => ({
  ...initialSearchData,
  setQuery: (q) => set({ query: q }),
  setResults: (r) => set({ results: r }),
  setSearching: (b) => set({ searching: b }),
  clear: () => set({ query: "", results: [], searching: false }),
}));
