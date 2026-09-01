import { useMemo } from "react";
import type { AgentInfo } from "../types";

export function statusDot(a: AgentInfo): { cls: string; label: string } {
  if (a.state !== "running") return { cls: "dead", label: a.state };
  if (a.live === "streaming") return { cls: "streaming", label: "streaming" };
  if (a.live === "exited") return { cls: "dead", label: "exited" };
  return { cls: "idle", label: "idle" };
}

export function uptime(startedAt: string | null): string {
  if (!startedAt) return "";
  const ms = Date.now() - new Date(startedAt).getTime();
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
  compact?: boolean;
  onOpenChat: (agentId: string) => void;
  onStart: (project?: string) => void;
}

/** Group running dashboard agents into sections by project. */
export function AgentsSections({ agents, compact, onOpenChat, onStart }: Props) {
  const managed = useMemo(() => agents.filter((a) => a.origin === "dashboard"), [agents]);
  const sections = useMemo(() => {
    const map = new Map<string, AgentInfo[]>();
    for (const a of managed) {
      const list = map.get(a.project) ?? [];
      list.push(a);
      map.set(a.project, list);
    }
    return [...map.entries()].sort(([p1], [p2]) => p1.localeCompare(p2));
  }, [managed]);

  if (managed.length === 0 && sections.length === 0) {
    return (
      <div className="empty">
        <p>No dashboard agents running.</p>
        <p className="dim">Start one to chat with pi on one of your projects.</p>
      </div>
    );
  }

  return (
    <div className="sections">
      {sections.map(([project, list]) => (
        <section key={project} className="section">
          <div className="section-head">
            <span className="section-title">{project}</span>
            <span className="section-actions">
              <button className="btn small" onClick={() => onStart(project)}>
                + start
              </button>
            </span>
          </div>
          {list.map((a) => (
            <AgentCard key={a.id} agent={a} compact={compact} onOpenChat={onOpenChat} />
          ))}
        </section>
      ))}
    </div>
  );
}

function AgentCard({
  agent,
  compact,
  onOpenChat,
}: {
  agent: AgentInfo;
  compact?: boolean;
  onOpenChat: (agentId: string) => void;
}) {
  const dot = statusDot(agent);
  const title = agent.sessionName || agent.name || agent.id.slice(0, 12);
  return (
    <button className="agent-card" onClick={() => onOpenChat(agent.id)} title={title}>
      <span className={`dot ${dot.cls}`} />
      <span className="agent-main">
        <span className="agent-title">{title}</span>
        {!compact && (
          <span className="agent-meta">
            {agent.model ?? "model?"}
            {agent.thinkingLevel ? ` · ${agent.thinkingLevel}` : ""}
          </span>
        )}
      </span>
      <span className="agent-side">
        {!compact && <span className="agent-meta">{uptime(agent.startedAt)}</span>}
        <span className="agent-status">{dot.label}</span>
      </span>
    </button>
  );
}
