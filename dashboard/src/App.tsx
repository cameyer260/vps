import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { AgentInfo } from "./types";
import { AgentsSections } from "./components/AgentsSections";
import { Chat } from "./components/Chat";
import { StartDialog } from "./components/StartDialog";

type View = { page: "agents" } | { page: "chat"; agentId: string } | { page: "notes" };

export default function App() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [view, setView] = useState<View>({ page: "agents" });
  const [startOpen, setStartOpen] = useState(false);
  const [startProject, setStartProject] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const poll = () => {
      api
        .agents()
        .then((r) => alive && setAgents(r.agents))
        .catch(() => {});
    };
    poll();
    const t = setInterval(poll, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const openChat = useCallback((agentId: string) => {
    setView({ page: "chat", agentId });
    setMenuOpen(false);
  }, []);

  const openStart = useCallback((project?: string) => {
    setStartProject(project ?? null);
    setStartOpen(true);
  }, []);

  const chatAgent =
    view.page === "chat" ? agents.find((a) => a.id === view.agentId) : undefined;
  // Keep the last known info around so an exiting/removed agent doesn't kick
  // the user out of the chat; the Chat itself shows the exited state.
  const lastChatAgentRef = useRef<AgentInfo | null>(null);
  if (chatAgent) lastChatAgentRef.current = chatAgent;
  const shownChatAgent = chatAgent ?? lastChatAgentRef.current;

  return (
    <div className="app">
      {menuOpen && <div className="scrim" onClick={() => setMenuOpen(false)} />}
      <aside className={`sidebar${menuOpen ? " open" : ""}`}>
        <div className="sidebar-head">
          <span className="brand">jarvis</span>
          <button className="btn primary" onClick={() => openStart()}>
            + New agent
          </button>
        </div>
        <div className="sidebar-body">
          <AgentsSections
            agents={agents}
            compact
            onOpenChat={openChat}
            onStart={openStart}
          />
        </div>
      </aside>

      <main className="main">
        {view.page === "chat" && shownChatAgent ? (
          <Chat
            key={shownChatAgent.id}
            agent={shownChatAgent}
            onBack={() => setView({ page: "agents" })}
            onTerminated={() => setView({ page: "agents" })}
          />
        ) : (
          <div className="overview">
            <div className="overview-head">
              <h1>Agents</h1>
              <button className="btn primary" onClick={() => openStart()}>
                + Start agent
              </button>
            </div>
            <AgentsSections agents={agents} onOpenChat={openChat} onStart={openStart} />
          </div>
        )}
      </main>

      {startOpen && (
        <StartDialog
          initialProject={startProject}
          agents={agents}
          onClose={() => setStartOpen(false)}
          onStarted={(agent) => {
            setStartOpen(false);
            openChat(agent.id);
          }}
        />
      )}

      <button className="menu-btn" onClick={() => setMenuOpen(true)} aria-label="Open menu">
        ☰
      </button>
    </div>
  );
}
