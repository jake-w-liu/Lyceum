// Per-language LSP status (M9), shown in the status bar.

import { create } from "zustand";

export type LspStatus = "off" | "starting" | "ready" | "error";

export interface LspStatusData {
  byLanguage: Record<string, LspStatus>;
}

export interface LspStatusActions {
  setStatus: (languageId: string, status: LspStatus) => void;
}

export type LspStatusState = LspStatusData & LspStatusActions;

export const initialLspStatusData: LspStatusData = { byLanguage: {} };

export const useLspStatusStore = create<LspStatusState>()((set) => ({
  ...initialLspStatusData,
  setStatus: (languageId, status) =>
    set((s) => ({ byLanguage: { ...s.byLanguage, [languageId]: status } })),
}));
