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

    let lastX = Number.isFinite(e.clientX) ? e.clientX : 0;
    let lastY = Number.isFinite(e.clientY) ? e.clientY : 0;

    function move(ev: PointerEvent): void {
      if (!Number.isFinite(ev.clientX) || !Number.isFinite(ev.clientY)) return;
      const dx = ev.clientX - lastX;
      const dy = ev.clientY - lastY;
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
      lastX = ev.clientX;
      lastY = ev.clientY;
      onDelta(dx, dy);
    }

    function up(): void {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      document.body.style.cursor = "";
    }

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    // Treat pointercancel (interrupted touch, OS gesture takeover, device
    // removal) like pointerup so the window listeners and body cursor never leak.
    window.addEventListener("pointercancel", up);
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
