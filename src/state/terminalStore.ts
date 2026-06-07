// Terminal sessions state (M5): the set of open terminals and the active one.
// The PTY itself lives in the Rust backend; this store tracks UI bookkeeping
// (id, title, cwd). Ids are sequential so they are deterministic for tests.

import { create } from "zustand";

export interface TerminalSession {
  id: string;
  title: string;
  cwd: string | null;
  /** Current backend PTY id for the mounted view, null while not ready. */
  backendPtyId: string | null;
  /** Optional command written to the PTY once it starts (e.g. a Julia REPL). */
  startupCommand?: string;
}

export interface CreateTerminalOptions {
  title?: string;
  startupCommand?: string;
}

export interface TerminalData {
  terminals: TerminalSession[];
  activeId: string | null;
  nextSeq: number;
}

export interface TerminalActions {
  /** Create a terminal session; returns its new id and makes it active. */
  createTerminal: (cwd?: string | null, opts?: CreateTerminalOptions) => string;
  closeTerminal: (id: string) => void;
  setActive: (id: string) => void;
  renameTerminal: (id: string, title: string) => void;
  setBackendPtyId: (id: string, backendPtyId: string) => void;
  clearBackendPtyId: (id: string, backendPtyId?: string) => void;
}

export type TerminalState = TerminalData & TerminalActions;

export const initialTerminalData: TerminalData = {
  terminals: [],
  activeId: null,
  nextSeq: 1,
};

export const useTerminalStore = create<TerminalState>()((set, get) => ({
  ...initialTerminalData,

  createTerminal: (cwd = null, opts) => {
    const seq = get().nextSeq;
    const id = `term-${seq}`;
    set((s) => ({
      terminals: [
        ...s.terminals,
        {
          id,
          title: opts?.title ?? `Terminal ${seq}`,
          cwd,
          backendPtyId: null,
          startupCommand: opts?.startupCommand,
        },
      ],
      activeId: id,
      nextSeq: s.nextSeq + 1,
    }));
    return id;
  },

  closeTerminal: (id) =>
    set((s) => {
      const index = s.terminals.findIndex((t) => t.id === id);
      if (index === -1) return {};
      const terminals = s.terminals.filter((t) => t.id !== id);
      if (s.activeId !== id) return { terminals };
      const neighbor = s.terminals[index - 1] ?? s.terminals[index + 1] ?? null;
      return { terminals, activeId: neighbor ? neighbor.id : null };
    }),

  setActive: (id) => set({ activeId: id }),

  renameTerminal: (id, title) =>
    set((s) => ({
      terminals: s.terminals.map((t) => (t.id === id ? { ...t, title } : t)),
    })),

  setBackendPtyId: (id, backendPtyId) =>
    set((s) => ({
      terminals: s.terminals.map((t) =>
        t.id === id ? { ...t, backendPtyId } : t,
      ),
    })),

  clearBackendPtyId: (id, backendPtyId) =>
    set((s) => ({
      terminals: s.terminals.map((t) => {
        if (t.id !== id) return t;
        if (backendPtyId !== undefined && t.backendPtyId !== backendPtyId) {
          return t;
        }
        return { ...t, backendPtyId: null };
      }),
    })),
}));
