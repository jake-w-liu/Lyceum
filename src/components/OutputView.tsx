// Output panel view (M8): shows captured run output (e.g. Julia) with a clear
// button and a running indicator.

import { useEffect, useRef } from "react";
import { useOutputStore } from "../state/outputStore";
import { stopActiveRun } from "../lib/run";

// While pinned to the bottom, streamed lines keep the view scrolled to the end.
// Scrolling up releases the pin so a chatty run can't yank the view away from
// what the user is reading; scrolling back to the bottom re-engages it.
const SCROLL_PIN_TOLERANCE_PX = 8;

export function OutputView() {
  const lines = useOutputStore((s) => s.lines);
  const running = useOutputStore((s) => s.running);
  const clear = useOutputStore((s) => s.clear);
  const logRef = useRef<HTMLPreElement>(null);
  // Pinned by default: a cleared/new run starts empty at the bottom.
  const pinnedRef = useRef(true);

  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    if (lines.length === 0) {
      // A cleared panel re-pins so the next run follows from the start.
      pinnedRef.current = true;
      return;
    }
    if (pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div className="output-view">
      <div className="output-toolbar">
        <span className="output-status">{running ? "Running…" : "Idle"}</span>
        {running && (
          <button
            type="button"
            className="output-stop"
            onClick={() => void stopActiveRun()}
          >
            Stop
          </button>
        )}
        <button type="button" className="output-clear" onClick={clear}>
          Clear
        </button>
      </div>
      <pre
        ref={logRef}
        className="output-log"
        aria-label="Output"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinnedRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight <=
            SCROLL_PIN_TOLERANCE_PX;
        }}
      >
        {lines.length === 0 ? "No output yet." : lines.join("\n")}
      </pre>
    </div>
  );
}
