// Cancel the in-flight run (Julia or LaTeX build). The backend kills the process
// for the tracked run id; the existing exit-event handler then clears the
// running/runId state (so a stopped run also unblocks the next run).

import { runCancel } from "./ipc";
import { useOutputStore } from "../state/outputStore";

/** Stop the currently running Julia/build process, if any. Best-effort. */
export async function stopActiveRun(): Promise<void> {
  const { running, runId } = useOutputStore.getState();
  if (!running || !runId) return;
  useOutputStore.getState().append("[stopping…]");
  try {
    await runCancel(runId);
  } catch {
    // best-effort: if cancel fails, the run continues and its exit will clear state.
  }
}
