import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TabBar } from "./TabBar";
import { initialEditorData, useEditorStore } from "../state/editorStore";
import { initialLayoutData, useLayoutStore } from "../state/layoutStore";

const get = () => useEditorStore.getState();

const seed = () => {
  get().openDoc({ path: "/w/a.ts", content: "a", language: "typescript" });
  get().openDoc({ path: "/w/b.ts", content: "b", language: "typescript" });
};

beforeEach(() => {
  useEditorStore.setState(initialEditorData, false);
  useLayoutStore.setState(initialLayoutData, false);
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

  it("hides the Preview action for non-previewable files", () => {
    seed(); // .ts files
    render(<TabBar />);
    expect(screen.queryByRole("button", { name: "Open Preview" })).toBeNull();
  });
});
