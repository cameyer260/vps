import type { TabKey } from "./BottomNav";

export const TAB_TITLES: Record<TabKey, string> = {
  agents: "Agents",
  ide: "IDE",
  gc: "General Chat",
};

interface Props {
  tab: TabKey;
  onHome: () => void;
  onStart?: () => void;
}

/**
 * Global chrome header: `Dashboard <Tab>` + actions. Tapping `Dashboard`
 * homes *within* the current tab (agents overview / IDE no-selection / GC
 * list home) — never a cross-tab home.
 *
 * The Agents tab owns a `+ Start agent` action on the right so the header
 * is the single top navbar (no second overview-head row below it).
 */
export function TabHeader({ tab, onHome, onStart }: Props) {
  const title = TAB_TITLES[tab];
  return (
    <header className="tab-header">
      <div className="tab-header-inner">
        <div className="tab-header-titles">
          <button
            className="tab-home"
            onClick={onHome}
            title={`Back to the ${title} start`}
            aria-label={`Dashboard home — back to the ${title} start`}
          >
            Dashboard
          </button>
          <span className="tab-name">{title}</span>
        </div>
        {tab === "agents" && onStart && (
          <button className="btn primary tab-start" onClick={onStart}>
            + Start agent
          </button>
        )}
      </div>
    </header>
  );
}
