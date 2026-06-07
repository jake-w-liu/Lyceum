import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BottomPanel } from "./BottomPanel";
import { initialLayoutData, useLayoutStore } from "../state/layoutStore";

// The real terminal mounts xterm (needs canvas/layout); stub it for this test.
vi.mock("./TerminalPanel", () => ({
  TerminalPanel: () => <div data-testid="terminal-stub">terminal</div>,
}));

beforeEach(() => {
  useLayoutStore.setState(
    { ...initialLayoutData, bottomPanelVisible: true },
    false,
  );
});

describe("BottomPanel", () => {
  it("selects the Terminal tab by default and mounts the terminal", async () => {
    render(<BottomPanel visible />);
    expect(screen.getByRole("tab", { name: "Terminal" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // Lazy terminal resolves asynchronously.
    expect(await screen.findByTestId("terminal-stub")).toBeInTheDocument();
  });

  it("switches to the Problems tab on click", async () => {
    const user = userEvent.setup();
    render(<BottomPanel visible />);
    await user.click(screen.getByRole("tab", { name: "Problems" }));
    expect(screen.getByRole("tab", { name: "Problems" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getByText("No problems have been detected."),
    ).toBeInTheDocument();
  });

  it("closes the panel when the Close Panel button is clicked", async () => {
    const user = userEvent.setup();
    render(<BottomPanel visible />);
    await user.click(screen.getByRole("button", { name: "Close Panel" }));
    expect(useLayoutStore.getState().bottomPanelVisible).toBe(false);
  });

  it("does not mount a terminal until the hidden panel is first shown", async () => {
    const { rerender } = render(<BottomPanel visible={false} />);
    expect(screen.queryByTestId("terminal-stub")).not.toBeInTheDocument();

    rerender(<BottomPanel visible />);

    expect(await screen.findByTestId("terminal-stub")).toBeInTheDocument();
  });

  it("keeps the mounted terminal alive when the panel is hidden", async () => {
    const { rerender } = render(<BottomPanel visible />);
    expect(await screen.findByTestId("terminal-stub")).toBeInTheDocument();

    rerender(<BottomPanel visible={false} />);

    expect(screen.getByTestId("terminal-stub")).toBeInTheDocument();
  });
});
