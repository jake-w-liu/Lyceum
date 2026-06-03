import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActivityBar } from "./ActivityBar";
import { initialLayoutData, useLayoutStore } from "../state/layoutStore";

describe("ActivityBar", () => {
  beforeEach(() => {
    useLayoutStore.setState(initialLayoutData, false);
  });

  it("renders all five view buttons plus Settings", () => {
    render(<ActivityBar />);
    expect(screen.getByLabelText("Explorer")).toBeTruthy();
    expect(screen.getByLabelText("Search")).toBeTruthy();
    expect(screen.getByLabelText("Source Control")).toBeTruthy();
    expect(screen.getByLabelText("Run and Debug")).toBeTruthy();
    expect(screen.getByLabelText("Extensions")).toBeTruthy();
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
});
