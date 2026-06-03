// Transient UI surface state (Zustand): which overlay/modal is open.
//
// Only one modal-like surface is open at a time. This is intentionally minimal
// and UI-only; nothing here is persisted across sessions.

import { create } from "zustand";

export type ModalKind = "palette" | "quickOpen";

export interface UiData {
  activeModal: ModalKind | null;
}

export interface UiActions {
  openModal: (kind: ModalKind) => void;
  closeModal: () => void;
  toggleModal: (kind: ModalKind) => void;
}

export type UiState = UiData & UiActions;

export const initialUiData: UiData = {
  activeModal: null,
};

export const useUiStore = create<UiState>()((set) => ({
  ...initialUiData,

  openModal: (kind) => set({ activeModal: kind }),
  closeModal: () => set({ activeModal: null }),
  toggleModal: (kind) =>
    set((s) => ({ activeModal: s.activeModal === kind ? null : kind })),
}));
