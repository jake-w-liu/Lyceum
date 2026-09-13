import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { OutputView } from "./OutputView";
import { initialOutputData, useOutputStore } from "../state/outputStore";

vi.mock("../lib/run", () => ({
  stopActiveRun: vi.fn(async () => {}),
}));

// jsdom has no layout: scroll metrics are always 0. These helpers give the
// <pre> a fake viewport so the stick-to-bottom behavior can be exercised.
function setScrollMetrics(
  el: HTMLElement,
  { scrollHeight, clientHeight }: { scrollHeight: number; clientHeight: number },
) {
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    value: scrollHeight,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    value: clientHeight,
  });
}

function appendLines(lines: string[]) {
  act(() => {
    for (const line of lines) useOutputStore.getState().append(line);
  });
}

beforeEach(() => {
  useOutputStore.setState(initialOutputData, false);
});

describe("OutputView", () => {
  it("follows newly appended output while pinned to the bottom", () => {
    const { container } = render(<OutputView />);
    const log = container.querySelector(".output-log") as HTMLElement;
    setScrollMetrics(log, { scrollHeight: 500, clientHeight: 100 });

    appendLines(["line 1", "line 2"]);
    expect(log.scrollTop).toBe(500);

    // More output + a taller log keeps the view pinned to the end.
    setScrollMetrics(log, { scrollHeight: 900, clientHeight: 100 });
    appendLines(["line 3"]);
    expect(log.scrollTop).toBe(900);
  });

  it("stops following when the user scrolls up and resumes at the bottom", () => {
    const { container } = render(<OutputView />);
    const log = container.querySelector(".output-log") as HTMLElement;
    setScrollMetrics(log, { scrollHeight: 500, clientHeight: 100 });

    appendLines(["line 1"]);
    expect(log.scrollTop).toBe(500);

    // User scrolls up to read earlier output.
    log.scrollTop = 120;
    fireEvent.scroll(log);
    setScrollMetrics(log, { scrollHeight: 700, clientHeight: 100 });
    appendLines(["line 2"]);
    expect(log.scrollTop).toBe(120);

    // Scrolling back to the bottom re-engages follow mode.
    log.scrollTop = 600;
    fireEvent.scroll(log);
    setScrollMetrics(log, { scrollHeight: 900, clientHeight: 100 });
    appendLines(["line 3"]);
    expect(log.scrollTop).toBe(900);
  });

  it("re-pins after the log is cleared so the next run follows from the start", () => {
    const { container } = render(<OutputView />);
    const log = container.querySelector(".output-log") as HTMLElement;
    setScrollMetrics(log, { scrollHeight: 500, clientHeight: 100 });

    appendLines(["old run"]);
    log.scrollTop = 0;
    fireEvent.scroll(log);

    act(() => {
      useOutputStore.getState().clear();
    });
    setScrollMetrics(log, { scrollHeight: 200, clientHeight: 100 });
    appendLines(["new run"]);
    expect(log.scrollTop).toBe(200);
  });

  it("shows the empty state and clears output from the toolbar", () => {
    render(<OutputView />);
    expect(screen.getByText("No output yet.")).toBeInTheDocument();

    appendLines(["hello"]);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(useOutputStore.getState().lines).toEqual([]);
  });
});
