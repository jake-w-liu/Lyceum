import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TabBar } from "./TabBar";
import { initialEditorData, useEditorStore } from "../state/editorStore";
import { initialLayoutData, useLayoutStore } from "../state/layoutStore";
import { initialOutputData, useOutputStore } from "../state/outputStore";

const runLatexBuildMock = vi.hoisted(() => vi.fn());
const runActiveJuliaMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/latexBuild", () => ({
  runLatexBuild: (...args: unknown[]) => runLatexBuildMock(...args),
}));
vi.mock("../lib/julia", () => ({
  runActiveJulia: (...args: unknown[]) => runActiveJuliaMock(...args),
}));

const get = () => useEditorStore.getState();

const seed = () => {
  get().openDoc({ path: "/w/a.ts", content: "a", language: "typescript" });
  get().openDoc({ path: "/w/b.ts", content: "b", language: "typescript" });
};

beforeEach(() => {
  useEditorStore.setState(initialEditorData, false);
  useLayoutStore.setState(initialLayoutData, false);
  useOutputStore.setState(initialOutputData, false);
  runLatexBuildMock.mockClear();
  runActiveJuliaMock.mockClear();
});

describe("TabBar", () => {
  it("renders both tab names and marks the active tab aria-selected", () => {
    seed();
    render(<TabBar />);

    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("b.ts")).toBeInTheDocument();
    // The most recently opened doc (b.ts) is active.
    expect(screen.getByRole("tab", { name: "b.ts" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "a.ts" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("activates a tab when its label is clicked", async () => {
    seed();
    render(<TabBar />);

    expect(get().activePath).toBe("/w/b.ts");
    await userEvent.click(screen.getByRole("tab", { name: "a.ts" }));
    expect(get().activePath).toBe("/w/a.ts");
  });

  it("closes a tab when its close button is clicked", async () => {
    seed();
    render(<TabBar />);

    expect(get().docs).toHaveLength(2);
    await userEvent.click(
      screen.getByRole("button", { name: "Close a.ts" }),
    );
    expect(get().docs).toHaveLength(1);
    expect(get().docs.map((d) => d.path)).toEqual(["/w/b.ts"]);
    expect(screen.queryByText("a.ts")).not.toBeInTheDocument();
  });

  it("closes all tabs from the topbar action", async () => {
    seed();
    render(<TabBar />);

    await userEvent.click(
      screen.getByRole("button", { name: "Close All Editors" }),
    );

    expect(get().docs).toEqual([]);
    expect(get().activePath).toBeNull();
    expect(screen.queryByText("a.ts")).not.toBeInTheDocument();
    expect(screen.queryByText("b.ts")).not.toBeInTheDocument();
  });

  it("closes a tab on middle-click", async () => {
    seed();
    render(<TabBar />);

    const tab = screen
      .getByRole("tab", { name: "a.ts" })
      .closest(".tab") as HTMLElement;
    fireEvent(
      tab,
      new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }),
    );

    await waitFor(() => expect(get().docs).toHaveLength(1));
    expect(get().docs.map((d) => d.path)).toEqual(["/w/b.ts"]);
  });

  it("ignores non-middle aux clicks", async () => {
    seed();
    render(<TabBar />);

    const tab = screen
      .getByRole("tab", { name: "a.ts" })
      .closest(".tab") as HTMLElement;
    fireEvent(
      tab,
      new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 2 }),
    );

    // Give any (incorrect) async close a chance to land before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(get().docs).toHaveLength(2);
  });

  it("shows a dirty indicator on a tab with unsaved changes", () => {
    seed();
    get().updateContent("/w/a.ts", "changed");
    render(<TabBar />);

    const dirtyTab = screen
      .getByRole("tab", { name: "a.ts" })
      .closest(".tab") as HTMLElement;
    const cleanTab = screen
      .getByRole("tab", { name: "b.ts" })
      .closest(".tab") as HTMLElement;

    expect(within(dirtyTab).getByText("●")).toBeInTheDocument();
    expect(within(cleanTab).queryByText("●")).not.toBeInTheDocument();
  });

  it("toggles in-place preview when the Preview action is clicked", async () => {
    get().openDoc({ path: "/w/notes.md", content: "# hi", language: "markdown" });
    render(<TabBar />);

    expect(useLayoutStore.getState().editorPreview).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Open Preview" }));
    expect(useLayoutStore.getState().editorPreview).toBe(true);

    // The action flips to "Show Source" and toggles preview back off.
    await userEvent.click(screen.getByRole("button", { name: "Show Source" }));
    expect(useLayoutStore.getState().editorPreview).toBe(false);
  });

  it("shows the Preview action for HTML files", () => {
    get().openDoc({
      path: "/w/index.html",
      content: "<h1>hi</h1>",
      language: "html",
    });
    render(<TabBar />);

    expect(screen.getByRole("button", { name: "Open Preview" })).toBeInTheDocument();
  });

  it("compiles the active LaTeX file without opening preview", async () => {
    get().openDoc({
      path: "/w/paper.tex",
      content: "\\documentclass{article}",
      language: "latex",
    });
    render(<TabBar />);

    await userEvent.click(
      screen.getByRole("button", { name: "Compile LaTeX" }),
    );

    expect(runLatexBuildMock).toHaveBeenCalledWith({
      targetPath: "/w/paper.tex",
      openOnSuccess: false,
    });
  });

  it("builds and opens the active LaTeX file from the Preview action", async () => {
    get().openDoc({
      path: "/w/paper.tex",
      content: "\\documentclass{article}",
      language: "latex",
    });
    render(<TabBar />);

    await userEvent.click(
      screen.getByRole("button", { name: "Preview LaTeX PDF" }),
    );

    expect(runLatexBuildMock).toHaveBeenCalledWith({
      targetPath: "/w/paper.tex",
      openOnSuccess: true,
    });
  });

  it("runs the active Julia file from the Run action", async () => {
    get().openDoc({
      path: "/w/analysis.jl",
      content: "println(1)",
      language: "julia",
    });
    render(<TabBar />);

    await userEvent.click(
      screen.getByRole("button", { name: "Run Julia File or Selection" }),
    );

    expect(runActiveJuliaMock).toHaveBeenCalledOnce();
  });

  it("keeps the Preview action outside the scrollable tab list", () => {
    for (let i = 0; i < 20; i++) {
      get().openDoc({
        path: `/w/file-${i}.ts`,
        content: "",
        language: "typescript",
      });
    }
    get().openDoc({
      path: "/w/index.html",
      content: "<h1>hi</h1>",
      language: "html",
    });
    const { container } = render(<TabBar />);

    const action = screen.getByRole("button", { name: "Open Preview" });
    const tabList = container.querySelector(".tab-list");
    expect(tabList).not.toContainElement(action);
  });

  it("scrolls overflowing tabs horizontally on touchpad wheel", () => {
    for (let i = 0; i < 20; i++) {
      get().openDoc({
        path: `/w/file-${i}.ts`,
        content: "",
        language: "typescript",
      });
    }
    const { container } = render(<TabBar />);
    const tabList = container.querySelector(".tab-list") as HTMLDivElement;
    Object.defineProperty(tabList, "clientWidth", {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(tabList, "scrollWidth", {
      configurable: true,
      value: 1000,
    });

    fireEvent.wheel(tabList, { deltaY: 80 });

    expect(tabList.scrollLeft).toBe(80);
  });

  it("hides the Preview action for non-previewable files", () => {
    seed(); // .ts files
    render(<TabBar />);
    expect(screen.queryByRole("button", { name: "Open Preview" })).toBeNull();
  });
});
