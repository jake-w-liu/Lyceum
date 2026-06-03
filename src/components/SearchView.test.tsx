import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

  it("requests opening the file when a result is clicked", async () => {
    useWorkspaceStore.setState({ rootPath: ROOT });
    vi.mocked(searchWorkspace).mockResolvedValue([
      match("/ws/a.jl", 3, "using LinearAlgebra"),
    ]);
    render(<SearchView />);
    await userEvent.type(screen.getByLabelText("Search workspace"), "using");
    const result = await screen.findByText("a.jl:3");
    await userEvent.click(result);
    expect(useWorkspaceStore.getState().pendingOpenPath).toBe("/ws/a.jl");
  });
});
