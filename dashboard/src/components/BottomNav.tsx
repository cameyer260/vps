import type { ReactNode } from "react";

export type TabKey = "agents" | "ide" | "gc";

interface Props {
  tab: TabKey;
  onChange: (tab: TabKey) => void;
}

function AgentsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <rect x="4" y="7" width="16" height="12" rx="3" />
      <path d="M12 7V4" />
      <circle cx="12" cy="3" r="1" fill="currentColor" stroke="none" />
      <circle cx="9" cy="12.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12.5" r="1" fill="currentColor" stroke="none" />
      <path d="M9.5 16h5" />
    </svg>
  );
}

function IdeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M4 6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H9l-5 4z" />
    </svg>
  );
}

const TABS: { key: TabKey; label: string; title: string; icon: ReactNode }[] = [
  { key: "agents", label: "Agents", title: "Agents", icon: <AgentsIcon /> },
  { key: "ide", label: "IDE", title: "IDE", icon: <IdeIcon /> },
  { key: "gc", label: "GC", title: "General Chat", icon: <ChatIcon /> },
];

/**
 * Global chrome bottom nav: one floating rounded pill with three segments.
 * Always visible — every tab, every state, chat views, above modals
 * (z-index beats the modal scrim), thumb-reachable with safe-area padding.
 * Same IA on desktop (centered pill + widened panels, builder judgment).
 */
export function BottomNav({ tab, onChange }: Props) {
  return (
    <nav className="bottom-nav" aria-label="Primary">
      <div className="bottom-pill" role="tablist" aria-label="Dashboard tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            aria-label={t.title}
            title={t.title}
            className={tab === t.key ? "active" : undefined}
            onClick={() => onChange(t.key)}
          >
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
