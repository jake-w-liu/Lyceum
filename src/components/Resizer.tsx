// Resizer: a draggable splitter handle used between shell regions.
//
// It is purely a gesture surface — it owns no sizing state. On pointer drag it
// reports incremental movement (dx, dy) via onDelta, and the parent decides how
// to apply that delta (clamping lives in the layout store). Pointer move/up are
// tracked on window so the drag keeps working even if the cursor leaves the
// thin handle.

import type { PointerEvent as ReactPointerEvent } from "react";

export function Resizer({
  orientation,
  ariaLabel,
  onDelta,
}: {
  orientation: "vertical" | "horizontal";
  ariaLabel: string;
  onDelta: (dx: number, dy: number) => void;
}) {
  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    e.preventDefault();

    let lastX = e.clientX;
    let lastY = e.clientY;

    function move(ev: PointerEvent): void {
      const dx = ev.clientX - lastX;
      const dy = ev.clientY - lastY;
      lastX = ev.clientX;
      lastY = ev.clientY;
      onDelta(dx, dy);
    }

    function up(): void {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
    }

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.style.cursor =
      orientation === "vertical" ? "col-resize" : "row-resize";
  }

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={ariaLabel}
      className={`resizer resizer-${orientation}`}
      onPointerDown={handlePointerDown}
    />
  );
}
