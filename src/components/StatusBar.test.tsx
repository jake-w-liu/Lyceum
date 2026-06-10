import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { StatusBar } from "./StatusBar";
import { initialOutputData, useOutputStore } from "../state/outputStore";
import { initialLayoutData, useLayoutStore } from "../state/layoutStore";
import { initialStatusData, useStatusStore } from "../state/statusStore";
import {
  initialWorkspaceData,
  useWorkspaceStore,
} from "../state/workspaceStore";

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
  useStatusStore.setState(initialStatusData, false);
  useWorkspaceStore.setState(initialWorkspaceData, false);
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

  it("shows the workspace folder name when a folder is open", () => {
    useWorkspaceStore.setState({ rootPath: "/Users/jake/proj" });
    render(<StatusBar />);
    expect(screen.getByText("proj")).toBeInTheDocument();
    expect(screen.queryByText("No folder opened")).toBeNull();
  });

  it("shows 'No folder opened' without a workspace", () => {
    render(<StatusBar />);
    expect(screen.getByText("No folder opened")).toBeInTheDocument();
  });

  it("renders the live cursor position from the status store", () => {
    render(<StatusBar />);
    expect(screen.getByText("Ln 1, Col 1")).toBeInTheDocument();

    act(() => {
      useStatusStore.getState().setCursor(42, 7);
    });
    expect(screen.getByText("Ln 42, Col 7")).toBeInTheDocument();
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
