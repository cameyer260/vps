import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { AgentInfo } from "./types";
import { AgentsSections } from "./components/AgentsSections";
import { Chat } from "./components/Chat";
import { NotesViewer } from "./components/NotesViewer";
import { StartDialog } from "./components/StartDialog";

type View = { page: "agents" } | { page: "chat"; agentId: string } | { page: "notes" };

export default function App() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [view, setView] = useState<View>({ page: "agents" });
  const [startOpen, setStartOpen] = useState(false);
  const [startProject, setStartProject] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [notesName, setNotesName] = useState("notes");

  useEffect(() => {
    api
      .projects()
      .then((r) => setNotesName(r.notes))
      .catch(() => {});
  }, []);

  // Agent list is push-based: one-shot initial fetch, then live updates via
  // the global events socket. Container lifecycle events trigger a (debounced)
  // refetch as the resync path; per-agent status transitions patch the cards
  // in place. A refetch on (re)connect covers any missed events.
  useEffect(() => {
    let alive = true;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let refetchDelay: ReturnType<typeof setTimeout> | null = null;

    const refetch = () => {
      api
        .agents()
        .then((r) => alive && setAgents(r.agents))
        .catch(() => {});
    };

    // Lifecycle events arrive in bursts (die + destroy, start waves); coalesce.
    const scheduleRefetch = () => {
      if (refetchDelay) return;
      refetchDelay = setTimeout(() => {
        refetchDelay = null;
        refetch();
      }, 250);
    };

    const connect = () => {
      if (!alive) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${proto}://${location.host}/ws/events`);
      ws = socket;
      socket.onopen = () => refetch();
      socket.onmessage = (e) => {
        let msg: { type?: string; id?: string; status?: AgentInfo["live"] };
        try {
          msg = JSON.parse(String(e.data));
        } catch {
          return;
        }
        if (msg.type === "agents_changed") {
          scheduleRefetch();
        } else if (msg.type === "agent_status" && msg.id && msg.status) {
          const { id, status } = msg;
          setAgents((prev) => prev.map((a) => (a.id === id ? { ...a, live: status } : a)));
        }
      };
      socket.onclose = () => {
        ws = null;
        if (alive) retry = setTimeout(connect, 2000);
      };
      socket.onerror = () => socket.close();
    };

    refetch();
    connect();

    return () => {
      alive = false;
      if (retry) clearTimeout(retry);
      if (refetchDelay) clearTimeout(refetchDelay);
      ws?.close();
      ws = null;
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
          <span className="brand">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
              <path d="M13 2 4.8 13.2c-.3.5 0 1.1.6 1.1h4.9l-1.6 7.2c-.1.6.6.9 1 .4L18 10.6c.3-.5 0-1.1-.6-1.1h-4.9l1.5-6.9c.1-.6-.6-.9-1-.6z" />
            </svg>
            dashboard
          </span>
          <button className="btn primary" onClick={() => openStart()}>
            + New agent
          </button>
        </div>
        <div className="sidebar-body">
          <AgentsSections
            agents={agents}
            notesName={notesName}
            compact
            onOpenChat={openChat}
            onOpenNotes={() => {
              setView({ page: "notes" });
              setMenuOpen(false);
            }}
            onStart={openStart}
            onStarted={(agent) => {
              setMenuOpen(false);
              openChat(agent.id);
            }}
          />
        </div>
      </aside>

      <main className="main">
        {view.page === "chat" && shownChatAgent ? (
          <Chat
            key={shownChatAgent.id}
            agent={shownChatAgent}
            notesName={notesName}
            onBack={() => setView({ page: "agents" })}
            onTerminated={() => setView({ page: "agents" })}
          />
        ) : view.page === "notes" ? (
          <NotesViewer notesName={notesName} onBack={() => setView({ page: "agents" })} />
        ) : (
          <div className="overview">
            <div className="overview-head">
              <h1>Agents</h1>
              <button className="btn primary" onClick={() => openStart()}>
                + Start agent
              </button>
            </div>
            <AgentsSections
              agents={agents}
              notesName={notesName}
              onOpenChat={openChat}
              onOpenNotes={() => setView({ page: "notes" })}
              onStart={openStart}
              onStarted={(agent) => openChat(agent.id)}
            />
          </div>
        )}
      </main>

      {startOpen && (
        <StartDialog
          initialProject={startProject}
          notesName={notesName}
          onClose={() => setStartOpen(false)}
          onStarted={(agent) => {
            setStartOpen(false);
            openChat(agent.id);
          }}
        />
      )}

      <button className="menu-btn" onClick={() => setMenuOpen(true)} aria-label="Open menu">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>
    </div>
  );
}
