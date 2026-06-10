import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchView } from "./SearchView";
import { initialSearchData, useSearchStore } from "../state/searchStore";
import type { SearchMatch } from "../state/searchStore";
import {
  initialWorkspaceData,
  useWorkspaceStore,
} from "../state/workspaceStore";

vi.mock("../lib/ipc", () => ({
  searchWorkspace: vi.fn(async (): Promise<SearchMatch[]> => []),
}));
import { searchWorkspace } from "../lib/ipc";

const ROOT = "/ws";
const match = (path: string, line: number, text: string): SearchMatch => ({
  path,
  line,
  column: 1,
  text,
});

beforeEach(() => {
  useSearchStore.setState(initialSearchData, false);
  useWorkspaceStore.setState(initialWorkspaceData, false);
  vi.mocked(searchWorkspace).mockReset();
  vi.mocked(searchWorkspace).mockResolvedValue([]);
});

describe("SearchView", () => {
  it("prompts to open a folder when none is open", () => {
    render(<SearchView />);
    expect(
      screen.getByPlaceholderText("Open a folder to search"),
    ).toBeInTheDocument();
  });

  it("does not search for queries shorter than two characters", async () => {
    useWorkspaceStore.setState({ rootPath: ROOT });
    render(<SearchView />);
    await userEvent.type(screen.getByLabelText("Search workspace"), "a");
    // Give the debounce window a chance to (not) fire.
    await new Promise((r) => setTimeout(r, 300));
    expect(searchWorkspace).not.toHaveBeenCalled();
  });

  it("runs a debounced search and renders results", async () => {
    useWorkspaceStore.setState({ rootPath: ROOT });
    vi.mocked(searchWorkspace).mockResolvedValue([
      match("/ws/a.jl", 3, "using LinearAlgebra"),
    ]);
    render(<SearchView />);
    await userEvent.type(screen.getByLabelText("Search workspace"), "using");
    await waitFor(() =>
      expect(searchWorkspace).toHaveBeenCalledWith(ROOT, "using"),
    );
    expect(await screen.findByText("a.jl:3")).toBeInTheDocument();
    expect(screen.getByText("using LinearAlgebra")).toBeInTheDocument();
  });

  it("requests opening the file at the match position when a result is clicked", async () => {
    useWorkspaceStore.setState({ rootPath: ROOT });
    vi.mocked(searchWorkspace).mockResolvedValue([
      { path: "/ws/a.jl", line: 3, column: 7, text: "using LinearAlgebra" },
    ]);
    render(<SearchView />);
    await userEvent.type(screen.getByLabelText("Search workspace"), "using");
    const result = await screen.findByText("a.jl:3");
    await userEvent.click(result);
    expect(useWorkspaceStore.getState().pendingOpenPath).toBe("/ws/a.jl");
    expect(useWorkspaceStore.getState().pendingOpenPosition).toEqual({
      line: 3,
      column: 7,
    });
  });

  it("supports ArrowDown/Up + Enter from the input to open a result", async () => {
    useWorkspaceStore.setState({ rootPath: ROOT });
    vi.mocked(searchWorkspace).mockResolvedValue([
      match("/ws/a.jl", 1, "first match"),
      match("/ws/b.jl", 2, "second match"),
    ]);
    render(<SearchView />);
    const input = screen.getByLabelText("Search workspace");
    await userEvent.type(input, "match");
    await screen.findByText("first match");

    await userEvent.keyboard("{ArrowDown}{Enter}");

    expect(useWorkspaceStore.getState().pendingOpenPath).toBe("/ws/b.jl");
    expect(useWorkspaceStore.getState().pendingOpenPosition).toEqual({
      line: 2,
      column: 1,
    });
  });

  it("shows an error message when the search fails (not 'No results')", async () => {
    useWorkspaceStore.setState({ rootPath: ROOT });
    vi.mocked(searchWorkspace).mockRejectedValue(new Error("ripgrep exploded"));
    render(<SearchView />);
    await userEvent.type(screen.getByLabelText("Search workspace"), "boom");

    expect(
      await screen.findByText(/Search failed: .*ripgrep exploded/),
    ).toBeInTheDocument();
    expect(screen.queryByText("No results")).toBeNull();
  });

  it("ignores a stale search response that resolves after a newer one", async () => {
    useWorkspaceStore.setState({ rootPath: ROOT });
    const deferreds: Array<(v: SearchMatch[]) => void> = [];
    vi.mocked(searchWorkspace).mockImplementation(
      () => new Promise<SearchMatch[]>((resolve) => deferreds.push(resolve)),
    );
    const wait = (ms: number) =>
      act(() => new Promise((r) => setTimeout(r, ms)));
    render(<SearchView />);
    const input = screen.getByLabelText("Search workspace");

    // First query dispatches after the debounce window...
    fireEvent.change(input, { target: { value: "ab" } });
    await wait(300);
    // ...then a newer query dispatches a second search.
    fireEvent.change(input, { target: { value: "abc" } });
    await wait(300);
    expect(deferreds).toHaveLength(2);

    // Resolve the NEWER request first, then the stale earlier one.
    await act(async () => {
      deferreds[1]([match("/ws/abc.jl", 1, "abc match")]);
      deferreds[0]([match("/ws/ab.jl", 9, "stale ab match")]);
      await Promise.resolve();
    });

    // The stale response must not overwrite the newer results.
    expect(useSearchStore.getState().results.map((r) => r.text)).toEqual([
      "abc match",
    ]);
  });

  it("clears the searching state when the query invalidates an in-flight search", async () => {
    useWorkspaceStore.setState({ rootPath: ROOT });
    const deferreds: Array<(v: SearchMatch[]) => void> = [];
    vi.mocked(searchWorkspace).mockImplementation(
      () => new Promise<SearchMatch[]>((resolve) => deferreds.push(resolve)),
    );
    const wait = (ms: number) =>
      act(() => new Promise((r) => setTimeout(r, ms)));
    render(<SearchView />);
    const input = screen.getByLabelText("Search workspace");

    fireEvent.change(input, { target: { value: "ab" } });
    await wait(300);
    expect(deferreds).toHaveLength(1);
    expect(useSearchStore.getState().searching).toBe(true);

    fireEvent.change(input, { target: { value: "" } });

    await waitFor(() => expect(useSearchStore.getState().searching).toBe(false));
    await act(async () => {
      deferreds[0]([match("/ws/ab.jl", 1, "stale result")]);
      await Promise.resolve();
    });
    expect(useSearchStore.getState().results).toEqual([]);
    expect(useSearchStore.getState().searching).toBe(false);
  });

  it("invalidates an in-flight search immediately when the workspace changes", async () => {
    useWorkspaceStore.setState({ rootPath: ROOT });
    const deferreds: Array<(v: SearchMatch[]) => void> = [];
    vi.mocked(searchWorkspace).mockImplementation(
      () => new Promise<SearchMatch[]>((resolve) => deferreds.push(resolve)),
    );
    const wait = (ms: number) =>
      act(() => new Promise((r) => setTimeout(r, ms)));
    render(<SearchView />);

    fireEvent.change(screen.getByLabelText("Search workspace"), {
      target: { value: "ab" },
    });
    await wait(300);
    expect(deferreds).toHaveLength(1);

    act(() => {
      useWorkspaceStore.setState({ rootPath: "/other", pendingOpenPath: null });
    });
    await act(async () => {
      deferreds[0]([match("/ws/ab.jl", 1, "stale result")]);
      await Promise.resolve();
    });

    expect(useSearchStore.getState().results).toEqual([]);
  });

  it("clears old results immediately when starting a new valid search", async () => {
    useWorkspaceStore.setState({ rootPath: ROOT });
    useSearchStore.getState().setQuery("old");
    useSearchStore
      .getState()
      .setResults([match("/ws/old.jl", 1, "old result")]);

    render(<SearchView />);

    expect(useSearchStore.getState().results).toEqual([]);
  });

  it("does not write stale results after the search view unmounts", async () => {
    useWorkspaceStore.setState({ rootPath: ROOT });
    const deferreds: Array<(v: SearchMatch[]) => void> = [];
    vi.mocked(searchWorkspace).mockImplementation(
      () => new Promise<SearchMatch[]>((resolve) => deferreds.push(resolve)),
    );
    const wait = (ms: number) =>
      act(() => new Promise((r) => setTimeout(r, ms)));
    const { unmount } = render(<SearchView />);

    fireEvent.change(screen.getByLabelText("Search workspace"), {
      target: { value: "ab" },
    });
    await wait(300);
    expect(deferreds).toHaveLength(1);

    unmount();
    await act(async () => {
      deferreds[0]([match("/ws/stale.jl", 1, "stale result")]);
      await Promise.resolve();
    });

    expect(useSearchStore.getState().results).toEqual([]);
    expect(useSearchStore.getState().searching).toBe(false);
  });
});
