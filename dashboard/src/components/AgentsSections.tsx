import { useMemo } from "react";
import type { AgentInfo } from "../types";
import { TerminateButton } from "./TerminateButton";
import { StartNotesButton } from "./StartNotesButton";

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
  notesName: string;
  compact?: boolean;
  onOpenChat: (agentId: string) => void;
  onOpenNotes: () => void;
  onStart: (project?: string) => void;
  onStarted?: (agent: { id: string; project: string }) => void;
}

/**
 * Dashboard agents grouped into sections by project. The notes project is
 * pinned at the top with a one-click "new conversation" — it's the everyday
 * ChatGPT replacement.
 */
export function AgentsSections({ agents, notesName, compact, onOpenChat, onOpenNotes, onStart, onStarted }: Props) {
  const managed = useMemo(() => agents.filter((a) => a.origin === "dashboard"), [agents]);
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
        <section key={project} className={`section${project === notesName ? " pinned" : ""}`}>
          <div className="section-head">
            <span className="section-title">
              {project === notesName ? `📝 ${notesName}` : project}
            </span>
            <span className="section-actions">
              {project === notesName && onStarted && (
                <StartNotesButton
                  notesName={notesName}
                  onStarted={onStarted}
                  label={compact ? "+ new" : undefined}
                />
              )}
              {project === notesName && (
                <button
                  className="btn small"
                  onClick={() => onStart(notesName)}
                  title="Pick an existing conversation to resume"
                >
                  resume…
                </button>
              )}
              {project === notesName && (
                <button className="btn small" onClick={onOpenNotes}>
                  view
                </button>
              )}
              {project !== notesName && (
                <button className="btn small" onClick={() => onStart(project)}>
                  + start
                </button>
              )}
            </span>
          </div>
          {list.map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              notesName={notesName}
              compact={compact}
              onOpenChat={onOpenChat}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

function AgentCard({
  agent,
  notesName,
  compact,
  onOpenChat,
}: {
  agent: AgentInfo;
  notesName: string;
  compact?: boolean;
  onOpenChat: (agentId: string) => void;
}) {
  const dot = statusDot(agent);
  const title = agent.sessionName || agent.name || agent.id.slice(0, 12);
  return (
    <div
      className="agent-card"
      onClick={() => onOpenChat(agent.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onOpenChat(agent.id)}
      title={title}
    >
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
      <TerminateButton agent={agent} notesName={notesName} small onTerminated={() => {}} />
    </div>
  );
}
