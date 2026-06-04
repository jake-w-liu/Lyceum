// Sidebar container for the workbench shell. Renders a header titled after the
// active activity-bar view. For the Explorer view it shows the file tree once a
// folder is opened (M2), or an "Open Folder" affordance otherwise.

import type { ActivityView } from "../state/layoutStore";
import { useLayoutStore } from "../state/layoutStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import { pickFolder } from "../lib/ipc";
import { Explorer } from "./Explorer";
import { SearchView } from "./SearchView";

const VIEW_TITLES: Record<ActivityView, string> = {
  explorer: "Explorer",
  search: "Search",
};

function ExplorerView() {
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);
  const requestOpenFile = useWorkspaceStore((s) => s.requestOpenFile);

  async function handleOpenFolder() {
    const path = await pickFolder();
    if (path) openWorkspace(path);
  }

  if (!rootPath) {
    return (
      <div className="sidebar-section placeholder">
        <p>You have not yet opened a folder.</p>
        <button type="button" onClick={handleOpenFolder}>
          Open Folder
        </button>
      </div>
    );
  }

  return <Explorer rootPath={rootPath} onOpenFile={requestOpenFile} />;
}

export function Sidebar() {
  const activeView = useLayoutStore((s) => s.activeView);
  const sidebarWidth = useLayoutStore((s) => s.sidebarWidth);
  const title = VIEW_TITLES[activeView];

  return (
    <aside className="sidebar" aria-label="Sidebar" style={{ width: sidebarWidth }}>
      <div className="sidebar-header">{title}</div>
      <div className="sidebar-body">
        {activeView === "explorer" ? (
          <ExplorerView />
        ) : (
          <SearchView />
        )}
      </div>
    </aside>
  );
}
