import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ContextMenu } from "./ContextMenu";
import {
  initialContextMenuData,
  useContextMenuStore,
} from "../state/contextMenuStore";

afterEach(() => useContextMenuStore.setState(initialContextMenuData, false));

describe("ContextMenu", () => {
  it("renders nothing when closed", () => {
    render(<ContextMenu />);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("renders items and runs one on click, then closes", () => {
    const run = vi.fn();
    useContextMenuStore.getState().openMenu(12, 12, [{ label: "Rename", run }]);
    render(<ContextMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));

    expect(run).toHaveBeenCalledTimes(1);
    expect(useContextMenuStore.getState().open).toBe(false);
  });

  it("dismisses on outside mousedown without running anything", () => {
    const run = vi.fn();
    useContextMenuStore.getState().openMenu(12, 12, [{ label: "Delete", run }]);
    render(<ContextMenu />);

    const overlay = screen.getByRole("menu").parentElement as HTMLElement;
    fireEvent.mouseDown(overlay);

    expect(useContextMenuStore.getState().open).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("dismisses on Escape without running anything", () => {
    const run = vi.fn();
    useContextMenuStore.getState().openMenu(12, 12, [{ label: "X", run }]);
    render(<ContextMenu />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(useContextMenuStore.getState().open).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("dismisses on scroll", () => {
    useContextMenuStore.getState().openMenu(12, 12, [{ label: "X", run: vi.fn() }]);
    render(<ContextMenu />);

    fireEvent.scroll(window);

    expect(useContextMenuStore.getState().open).toBe(false);
  });

  it("marks disabled items as disabled", () => {
    useContextMenuStore
      .getState()
      .openMenu(12, 12, [{ label: "Rename", run: vi.fn(), disabled: true }]);
    render(<ContextMenu />);
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeDisabled();
  });
});
