import type { ReactNode } from "react";
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
  /** Right-aligned navbar actions — the IDE tab renders search → pencil → commit here. */
  actions?: ReactNode;
}

/**
 * Global chrome header: `Dashboard <Tab>` + actions. Tapping `Dashboard`
 * homes *within* the current tab (agents overview / IDE no-selection / GC
 * list home) — never a cross-tab home.
 *
 * The Agents tab owns a `+ Start agent` action on the right so the header
 * is the single top navbar (no second overview-head row below it); the IDE
 * tab renders its published actions (search → pencil → commit) via the
 * generic `actions` slot instead.
 */
export function TabHeader({ tab, onHome, onStart, actions }: Props) {
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
        {actions ? (
          <div className="tab-header-actions">{actions}</div>
        ) : (
          tab === "agents" &&
          onStart && (
            <button className="btn primary tab-start" onClick={onStart}>
              + Start agent
            </button>
          )
        )}
      </div>
    </header>
  );
}
