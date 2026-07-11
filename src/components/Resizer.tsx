// Resizer: a draggable splitter handle used between shell regions.
//
// It is purely a gesture surface — it owns no sizing state. On pointer drag it
// reports incremental movement (dx, dy) via onDelta, and the parent decides how
// to apply that delta (clamping lives in the layout store). Pointer move/up are
// tracked on window so the drag keeps working even if the cursor leaves the
// thin handle.

import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

export function Resizer({
  orientation,
  ariaLabel,
  onDelta,
}: {
  orientation: "vertical" | "horizontal";
  ariaLabel: string;
  onDelta: (dx: number, dy: number) => void;
}) {
  const activeDragCleanupRef = useRef<(() => void) | null>(null);

  // The splitter can unmount while a drag is active (for example when a panel is
  // hidden by a keyboard command). Release the window listeners and global cursor
  // in that path too; pointerup may never reach a handle that no longer exists.
  useEffect(
    () => () => {
      activeDragCleanupRef.current?.();
    },
    [],
  );

  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    e.preventDefault();

    // Defensive against a second pointer-down before the first gesture ended.
    activeDragCleanupRef.current?.();

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

    const cleanup = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      document.body.style.cursor = "";
      if (activeDragCleanupRef.current === cleanup) {
        activeDragCleanupRef.current = null;
      }
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", cleanup);
    // Treat pointercancel (interrupted touch, OS gesture takeover, device
    // removal) like pointerup so the window listeners and body cursor never leak.
    window.addEventListener("pointercancel", cleanup);
    activeDragCleanupRef.current = cleanup;
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
