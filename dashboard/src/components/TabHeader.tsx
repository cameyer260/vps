import type { TabKey } from "./BottomNav";

export const TAB_TITLES: Record<TabKey, string> = {
  agents: "Agents",
  ide: "IDE",
  gc: "General Chat",
};

interface Props {
  tab: TabKey;
  onHome: () => void;
}

/**
 * Global chrome header: `Dashboard - <Tab>`. Tapping `Dashboard` homes
 * *within* the current tab (agents overview / IDE no-selection / GC list
 * home) — never a cross-tab home. The per-tab home targets land in later
 * phases; phase 1 wires the agents-overview home, the other tabs are
 * already at home.
 */
export function TabHeader({ tab, onHome }: Props) {
  const title = TAB_TITLES[tab];
  return (
    <header className="tab-header">
      <div className="tab-header-inner">
        <button
          className="tab-home"
          onClick={onHome}
          title={`Back to the ${title} start`}
          aria-label={`Dashboard home — back to the ${title} start`}
        >
          Dashboard
        </button>
        <span className="tab-sep" aria-hidden="true">
          {" "}
          -{" "}
        </span>
        <span className="tab-name">{title}</span>
      </div>
    </header>
  );
}
