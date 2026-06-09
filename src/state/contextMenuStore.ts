// Global right-click context menu state (Zustand). Any surface opens the menu
// at a screen position with a list of items; a single <ContextMenu /> mounted at
// the app root renders it. Items only dispatch behavior the caller already owns
// (commands, store actions), so the menu carries no domain logic of its own.

import { create } from "zustand";

export interface ContextMenuItem {
  label: string;
  run: () => void;
  /** Greyed out and non-interactive when true. */
  disabled?: boolean;
  /** Draw a divider above this item (group separator). */
  separatorBefore?: boolean;
}

export interface ContextMenuData {
  open: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
}

export interface ContextMenuActions {
  openMenu: (x: number, y: number, items: ContextMenuItem[]) => void;
  closeMenu: () => void;
}

export type ContextMenuState = ContextMenuData & ContextMenuActions;

export const initialContextMenuData: ContextMenuData = {
  open: false,
  x: 0,
  y: 0,
  items: [],
};

export const useContextMenuStore = create<ContextMenuState>()((set) => ({
  ...initialContextMenuData,
  openMenu: (x, y, items) => set({ open: true, x, y, items }),
  closeMenu: () => set({ open: false, items: [] }),
}));
