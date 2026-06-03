import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBar } from "./StatusBar";

vi.mock("../lib/ipc", () => ({
  getAppInfo: vi.fn(async () => ({
    name: "Lyceum",
    version: "9.9.9",
    os: "testos",
    arch: "testarch",
  })),
}));

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
});
