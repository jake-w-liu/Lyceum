import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { StatusBar } from "./StatusBar";
import { initialOutputData, useOutputStore } from "../state/outputStore";
import { initialLayoutData, useLayoutStore } from "../state/layoutStore";

vi.mock("../lib/ipc", () => ({
  getAppInfo: vi.fn(async () => ({
    name: "Lyceum",
    version: "9.9.9",
    os: "testos",
    arch: "testarch",
  })),
}));

beforeEach(() => {
  useOutputStore.setState(initialOutputData, false);
  useLayoutStore.setState(initialLayoutData, false);
});

describe("StatusBar", () => {
  it("renders static items and live platform info", async () => {
    render(<StatusBar />);

    expect(screen.getByText("Lyceum")).toBeInTheDocument();
    expect(screen.getByText("Ln 1, Col 1")).toBeInTheDocument();

    const el = await screen.findByTestId("status-platform");
    expect(el).toHaveTextContent("testos");
    expect(el).toHaveTextContent("testarch");
    expect(el).toHaveTextContent("v9.9.9");
  });

  it("hides the running indicator when idle", () => {
    render(<StatusBar />);
    expect(screen.queryByTestId("status-running")).toBeNull();
  });

  it("shows a running indicator that opens the Output panel when clicked", () => {
    useOutputStore.setState({ ...initialOutputData, running: true }, false);
    render(<StatusBar />);

    const button = screen.getByTestId("status-running");
    expect(button).toBeInTheDocument();

    fireEvent.click(button);
    expect(useLayoutStore.getState().bottomPanelVisible).toBe(true);
    expect(useLayoutStore.getState().activeBottomTab).toBe("output");
  });
});
