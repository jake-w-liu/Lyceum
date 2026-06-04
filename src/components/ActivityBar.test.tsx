import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActivityBar } from "./ActivityBar";
import { initialLayoutData, useLayoutStore } from "../state/layoutStore";
import { commandRegistry } from "../commands/commandRegistry";

describe("ActivityBar", () => {
  beforeEach(() => {
    useLayoutStore.setState(initialLayoutData, false);
    vi.restoreAllMocks();
  });

  it("renders implemented view buttons plus Settings", () => {
    render(<ActivityBar />);
    expect(screen.getByLabelText("Explorer")).toBeTruthy();
    expect(screen.getByLabelText("Search")).toBeTruthy();
    expect(screen.queryByLabelText("Source Control")).toBeNull();
    expect(screen.queryByLabelText("Run and Debug")).toBeNull();
    expect(screen.queryByLabelText("Extensions")).toBeNull();
    expect(screen.getByLabelText("Settings")).toBeTruthy();
  });

  it("marks Explorer active by default", () => {
    render(<ActivityBar />);
    expect(screen.getByLabelText("Explorer").getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("switches to Search and keeps the sidebar visible", async () => {
    const user = userEvent.setup();
    render(<ActivityBar />);

    await user.click(screen.getByLabelText("Search"));

    expect(useLayoutStore.getState().activeView).toBe("search");
    expect(useLayoutStore.getState().sidebarVisible).toBe(true);
    expect(screen.getByLabelText("Search").getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("collapses the sidebar when the active view is clicked again", async () => {
    const user = userEvent.setup();
    render(<ActivityBar />);

    await user.click(screen.getByLabelText("Explorer"));

    expect(useLayoutStore.getState().sidebarVisible).toBe(false);
  });

  it("opens settings through the command registry", async () => {
    const execute = vi.spyOn(commandRegistry, "execute").mockResolvedValue();
    const user = userEvent.setup();
    render(<ActivityBar />);

    await user.click(screen.getByLabelText("Settings"));

    expect(execute).toHaveBeenCalledWith("file.openSettings");
  });
});
