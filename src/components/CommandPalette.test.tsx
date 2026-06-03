// Tests for the command palette overlay: visibility, fuzzy filtering, and
// keyboard-driven run/dismiss behavior.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette } from "./CommandPalette";
import { initialUiData, useUiStore } from "../state/uiStore";
import { commandRegistry } from "../commands/commandRegistry";

const runOne = vi.fn();
const runTwo = vi.fn();

beforeEach(() => {
  useUiStore.setState(initialUiData, false);
  commandRegistry.clear();
  runOne.mockClear();
  runTwo.mockClear();
  commandRegistry.register({ id: "a.one", title: "Toggle Sidebar", run: runOne });
  commandRegistry.register({ id: "a.two", title: "Open Terminal", run: runTwo });
});

describe("CommandPalette", () => {
  it("renders nothing when no modal is active", () => {
    render(<CommandPalette />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the dialog and all commands when opened", () => {
    useUiStore.getState().openModal("palette");
    render(<CommandPalette />);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Toggle Sidebar")).toBeInTheDocument();
    expect(screen.getByText("Open Terminal")).toBeInTheDocument();
  });

  it("filters by query and runs the match on Enter", async () => {
    const user = userEvent.setup();
    useUiStore.getState().openModal("palette");
    render(<CommandPalette />);

    const input = screen.getByLabelText("Command input");
    await user.type(input, "term");

    expect(screen.queryByText("Toggle Sidebar")).toBeNull();
    expect(screen.getByText("Open Terminal")).toBeInTheDocument();

    await user.keyboard("{Enter}");

    expect(runTwo).toHaveBeenCalledTimes(1);
    expect(runOne).not.toHaveBeenCalled();
    expect(useUiStore.getState().activeModal).toBeNull();
  });

  it("closes on Escape without running a command", async () => {
    const user = userEvent.setup();
    useUiStore.getState().openModal("palette");
    render(<CommandPalette />);

    await user.keyboard("{Escape}");

    expect(useUiStore.getState().activeModal).toBeNull();
    expect(runOne).not.toHaveBeenCalled();
    expect(runTwo).not.toHaveBeenCalled();
  });
});
