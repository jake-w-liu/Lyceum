// Vertical activity bar: the left-most strip of the workbench.
//
// Each top item selects an activity-bar view (Explorer, Search, etc.). Clicking
// the already-active view collapses the sidebar (VS Code behavior), handled by
// the store's `selectView`. The bottom Settings button is a placeholder until
// M10. Icons are decorative; the buttons carry the accessible labels.

import { Icon, type IconName } from "./Icon";
import { useLayoutStore, type ActivityView } from "../state/layoutStore";

interface ViewItem {
  id: ActivityView;
  label: string;
  icon: IconName;
}

const VIEWS: ViewItem[] = [
  { id: "explorer", label: "Explorer", icon: "explorer" },
  { id: "search", label: "Search", icon: "search" },
  { id: "source-control", label: "Source Control", icon: "source-control" },
  { id: "run", label: "Run and Debug", icon: "run" },
  { id: "extensions", label: "Extensions", icon: "extensions" },
];

export function ActivityBar() {
  const sidebarVisible = useLayoutStore((s) => s.sidebarVisible);
  const activeView = useLayoutStore((s) => s.activeView);
  const selectView = useLayoutStore((s) => s.selectView);

  return (
    <nav className="activity-bar" aria-label="Activity Bar">
      <ul className="activity-bar-items">
        {VIEWS.map(({ id, label, icon }) => {
          const active = sidebarVisible && activeView === id;
          return (
            <li key={id}>
              <button
                className={"activity-bar-item" + (active ? " active" : "")}
                type="button"
                aria-label={label}
                title={label}
                aria-pressed={active}
                onClick={() => selectView(id)}
              >
                <Icon name={icon} />
              </button>
            </li>
          );
        })}
      </ul>
      <ul className="activity-bar-bottom">
        <li>
          <button
            className="activity-bar-item"
            type="button"
            aria-label="Settings"
            title="Settings (M10)"
          >
            <Icon name="settings" />
          </button>
        </li>
      </ul>
    </nav>
  );
}
