import { useEffect, useMemo, useState } from "react";
import type { AgentInfo } from "../types";
import { statusDot } from "./agentStatus";
import { TerminateButton } from "./TerminateButton";

export { statusDot } from "./agentStatus";

/** Minute-resolution clock for elapsed-time labels: re-renders the list on
 *  a 30s interval so `uptime()` stays fresh without server traffic. (The
 *  /ws/events socket only pushes on lifecycle/status transitions — there
 *  is no clock in it, so a local ticker is the mechanism here.) */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function uptime(startedAt: string | null, now: number = Date.now()): string {
  if (!startedAt) return "";
  const ms = now - new Date(startedAt).getTime();
  if (ms < 0 || Number.isNaN(ms)) return "";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ${min % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

interface Props {
  agents: AgentInfo[];
  notesName: string;
  onOpenChat: (agentId: string) => void;
  onStart: (project?: string) => void;
}

/**
 * Agents tab (spec §3): a single scrolling column grouped by project. Each
 * row shows the chat name, how long it has been running, and a status dot
 * (green = done/waiting, orange = running/working, dim = exited/dead —
 * see agentStatus.ts); tapping a row opens that agent chat (shared
 * ChatView). General Chat conversations are hidden here — they live only
 * in the GC tab. Live updates arrive in place via the global events socket
 * in App.tsx — no polling here. The header `+` (App overview-head) and the
 * empty-state `+` both open the New Agent modal.
 */
export function AgentsSections({ agents, notesName, onOpenChat, onStart }: Props) {
  const now = useNow();
  // General Chat conversations live only in the GC tab (restored across
  // reloads via localStorage, reaped when idle) — never in this list.
  const managed = useMemo(
    () => agents.filter((a) => a.origin === "dashboard" && !a.generalChat),
    [agents],
  );
  const sections = useMemo(() => {
    const map = new Map<string, AgentInfo[]>();
    for (const a of managed) {
      const list = map.get(a.project) ?? [];
      list.push(a);
      map.set(a.project, list);
    }
    // notes pinned first, rest alphabetical
    return [...map.entries()].sort(([p1], [p2]) =>
      p1 === notesName ? -1 : p2 === notesName ? 1 : p1.localeCompare(p2),
    );
  }, [managed, notesName]);

  if (managed.length === 0) {
    return (
      <div className="empty agents-empty">
        <p className="agents-empty-title">No Agents Running</p>
        <p className="dim">Start one</p>
        <button
          className="btn primary agents-plus"
          onClick={() => onStart()}
          aria-label="Start one — open the New Agent modal"
        >
          +
        </button>
      </div>
    );
  }

  return (
    <div className="agents-list">
      {sections.map(([project, list]) => (
        <section key={project} className="agent-group">
          <h2 className="agent-group-title">{project}</h2>
          {list.map((a) => (
            <AgentRow key={a.id} agent={a} now={now} onOpenChat={onOpenChat} />
          ))}
        </section>
      ))}
    </div>
  );
}

function AgentRow({
  agent,
  now,
  onOpenChat,
}: {
  agent: AgentInfo;
  now: number;
  onOpenChat: (agentId: string) => void;
}) {
  const dot = statusDot(agent);
  // Never a docker container name (Group F): untitled until pi titles the
  // conversation from the first message.
  const title = agent.sessionName || "New chat";
  const isHost = agent.runtime === "host";
  return (
    <div
      className="agent-row"
      onClick={() => onOpenChat(agent.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onOpenChat(agent.id)}
      title={isHost && agent.directory ? `${title} — ${agent.directory}` : title}
    >
      <span className={`dot ${dot.cls}`} aria-hidden="true" />
      <span className="agent-main">
        <span className="agent-title">
          {title}
          {isHost && (
            <span className="jarvis-off-pill" title={agent.directory ?? "bare-metal host pi"}>
              jarvis off
            </span>
          )}
        </span>
      </span>
      <span className="agent-side">
        <span className="agent-meta">{uptime(agent.startedAt, now)}</span>
        <span className="agent-status">{dot.label}</span>
      </span>
      <TerminateButton agent={agent} small onTerminated={() => {}} />
    </div>
  );
}
