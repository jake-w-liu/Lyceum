// Cancel the in-flight run (code profile or LaTeX build). The backend kills the process
// for the tracked run id; the existing exit-event handler then clears the
// running/runId state (so a stopped run also unblocks the next run).

import { runCancel } from "./ipc";
import { flushOutputBuffer, useOutputStore } from "../state/outputStore";

/** Stop the currently running code/build process, if any. Best-effort. */
export async function stopActiveRun(): Promise<void> {
  const { running, runId } = useOutputStore.getState();
  if (!running || !runId) return;
  // Flush buffered streamed output first (like handleExit / the latex catch) so
  // earlier process lines stay ABOVE this marker instead of flushing below it.
  flushOutputBuffer();
  useOutputStore.getState().append("[stopping…]");
  try {
    await runCancel(runId);
  } catch {
    // best-effort: if cancel fails, the run continues and its exit will clear state.
  }
}
