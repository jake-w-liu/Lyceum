import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
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

  it("focuses the first enabled item when opened", () => {
    useContextMenuStore.getState().openMenu(12, 12, [
      { label: "Disabled", run: vi.fn(), disabled: true },
      { label: "First", run: vi.fn() },
      { label: "Second", run: vi.fn() },
    ]);
    render(<ContextMenu />);

    expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus();
  });

  it("moves focus with ArrowDown/ArrowUp, wrapping past the ends", () => {
    useContextMenuStore.getState().openMenu(12, 12, [
      { label: "First", run: vi.fn() },
      { label: "Skipped", run: vi.fn(), disabled: true },
      { label: "Last", run: vi.fn() },
    ]);
    render(<ContextMenu />);
    const menu = screen.getByRole("menu");

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Last" })).toHaveFocus();
    // Wraps from the last enabled item back to the first.
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus();
    // And backwards.
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(screen.getByRole("menuitem", { name: "Last" })).toHaveFocus();
  });

  it("restores focus to the invoking element when dismissed with Escape", () => {
    render(
      <>
        <button type="button">invoker</button>
        <ContextMenu />
      </>,
    );
    const invoker = screen.getByRole("button", { name: "invoker" });
    invoker.focus();
    act(() => {
      useContextMenuStore
        .getState()
        .openMenu(12, 12, [{ label: "X", run: vi.fn() }]);
    });
    expect(screen.getByRole("menuitem", { name: "X" })).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(useContextMenuStore.getState().open).toBe(false);
    expect(invoker).toHaveFocus();
  });

  it("restores focus to the invoking element after running an item", () => {
    render(
      <>
        <button type="button">invoker</button>
        <ContextMenu />
      </>,
    );
    const invoker = screen.getByRole("button", { name: "invoker" });
    invoker.focus();
    act(() => {
      useContextMenuStore
        .getState()
        .openMenu(12, 12, [{ label: "Rename", run: vi.fn() }]);
    });

    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));

    expect(invoker).toHaveFocus();
  });

  it("jumps to the first/last enabled item with Home/End", () => {
    useContextMenuStore.getState().openMenu(12, 12, [
      { label: "First", run: vi.fn() },
      { label: "Middle", run: vi.fn() },
      { label: "Last", run: vi.fn() },
    ]);
    render(<ContextMenu />);
    const menu = screen.getByRole("menu");

    fireEvent.keyDown(menu, { key: "End" });
    expect(screen.getByRole("menuitem", { name: "Last" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Home" });
    expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus();
  });
});
