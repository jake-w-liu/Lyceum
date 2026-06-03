import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TabBar } from "./TabBar";
import { initialEditorData, useEditorStore } from "../state/editorStore";

const get = () => useEditorStore.getState();

const seed = () => {
  get().openDoc({ path: "/w/a.ts", content: "a", language: "typescript" });
  get().openDoc({ path: "/w/b.ts", content: "b", language: "typescript" });
};

beforeEach(() => {
  useEditorStore.setState(initialEditorData, false);
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
});
