import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Resizer } from "./Resizer";

afterEach(() => {
  fireEvent.pointerUp(window);
  document.body.style.cursor = "";
});

describe("Resizer", () => {
  it("releases an active drag when the splitter unmounts", () => {
    const onDelta = vi.fn();
    const { unmount } = render(
      <Resizer
        orientation="vertical"
        ariaLabel="Resize sidebar"
        onDelta={onDelta}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("separator"), {
      clientX: 10,
      clientY: 20,
    });
    expect(document.body.style.cursor).toBe("col-resize");

    unmount();
    fireEvent.pointerMove(window, { clientX: 30, clientY: 40 });

    expect(onDelta).not.toHaveBeenCalled();
    expect(document.body.style.cursor).toBe("");
  });
});
