// Bottom panel hosting the Terminal / Problems / Output tabs.
//
// The live terminal (M5) is lazy-loaded and stays mounted once first opened
// (hidden on other tabs) so switching to Problems/Output does not kill running
// shells. Closing the whole panel unmounts it (and closes its PTYs).

import { Suspense, lazy, useEffect, useState } from "react";
import { useLayoutStore } from "../state/layoutStore";
import type { BottomTab } from "../state/layoutStore";
import { Icon } from "./Icon";
import { OutputView } from "./OutputView";

const TerminalPanel = lazy(() =>
  import("./TerminalPanel").then((m) => ({ default: m.TerminalPanel })),
);

const tabs: { id: BottomTab; label: string }[] = [
  { id: "terminal", label: "Terminal" },
  { id: "problems", label: "Problems" },
  { id: "output", label: "Output" },
];

export function BottomPanel() {
  const bottomPanelHeight = useLayoutStore((s) => s.bottomPanelHeight);
  const activeBottomTab = useLayoutStore((s) => s.activeBottomTab);
  const setActiveBottomTab = useLayoutStore((s) => s.setActiveBottomTab);
  const toggleBottomPanel = useLayoutStore((s) => s.toggleBottomPanel);

  // Mount the terminal lazily, the first time its tab is shown, then keep it.
  const [terminalMounted, setTerminalMounted] = useState(
    activeBottomTab === "terminal",
  );
  useEffect(() => {
    if (activeBottomTab === "terminal") setTerminalMounted(true);
  }, [activeBottomTab]);

  return (
    <section
      className="bottom-panel"
      aria-label="Panel"
      style={{ height: bottomPanelHeight }}
    >
      <div className="panel-header">
        <div className="panel-tabs" role="tablist" aria-label="Panel tabs">
          {tabs.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={activeBottomTab === id}
              className={"panel-tab" + (activeBottomTab === id ? " active" : "")}
              onClick={() => setActiveBottomTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="Close Panel"
          onClick={toggleBottomPanel}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="panel-content" role="tabpanel">
        {terminalMounted && (
          <div
            className="terminal-slot"
            style={{ display: activeBottomTab === "terminal" ? "flex" : "none" }}
          >
            <Suspense
              fallback={<div className="panel-body">Loading terminal…</div>}
            >
              <TerminalPanel />
            </Suspense>
          </div>
        )}
        {activeBottomTab === "problems" && (
          <div className="panel-body">No problems have been detected.</div>
        )}
        {activeBottomTab === "output" && <OutputView />}
      </div>
    </section>
  );
}
