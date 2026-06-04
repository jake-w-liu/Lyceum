// Output panel view (M8): shows captured run output (e.g. Julia) with a clear
// button and a running indicator.

import { useOutputStore } from "../state/outputStore";
import { stopActiveRun } from "../lib/run";

export function OutputView() {
  const lines = useOutputStore((s) => s.lines);
  const running = useOutputStore((s) => s.running);
  const clear = useOutputStore((s) => s.clear);

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
      <pre className="output-log" aria-label="Output">
        {lines.length === 0 ? "No output yet." : lines.join("\n")}
      </pre>
    </div>
  );
}
