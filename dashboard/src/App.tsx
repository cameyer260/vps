import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { AgentInfo } from "./types";
import { AgentsSections } from "./components/AgentsSections";
import { Chat } from "./components/Chat";
import { NotesViewer } from "./components/NotesViewer";
import { StartDialog } from "./components/StartDialog";
import { TabHeader } from "./components/TabHeader";
import { BottomNav, type TabKey } from "./components/BottomNav";

export default function App() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [tab, setTab] = useState<TabKey>("agents");
  // Agent chat is a sub-state of the Agents tab (agents / agent-chat).
  const [chatAgentId, setChatAgentId] = useState<string | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  const [startProject, setStartProject] = useState<string | null>(null);
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
      socket.onopen = () => {
        if (ws !== socket) {
          try {
            socket.close();
          } catch {
            /* already gone */
          }
          return;
        }
        refetch();
      };
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
        // A superseded socket (StrictMode double-mount) must not clear the
        // live connection or schedule a duplicate one — see useChat.
        if (ws !== socket) return;
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
      const sock = ws;
      ws = null;
      // See useChat: never abort a connecting handshake (browser warning);
      // the onopen guard closes superseded sockets once established.
      if (sock && sock.readyState !== WebSocket.CONNECTING) {
        try {
          sock.close();
        } catch {
          /* already gone */
        }
      }
    };
  }, []);

  const openChat = useCallback((agentId: string) => {
    setTab("agents");
    setChatAgentId(agentId);
  }, []);

  const openStart = useCallback((project?: string) => {
    setStartProject(project ?? null);
    setStartOpen(true);
  }, []);

  // Tap `Dashboard` in the header: home *within* the current tab. Agents
  // returns to the overview; IDE/GC have no sub-state in phase 1 (their
  // picker/list homes arrive with phases 5/7), so they are already home.
  const goHome = useCallback(() => {
    if (tab === "agents") setChatAgentId(null);
  }, [tab]);

  const chatAgent = chatAgentId ? agents.find((a) => a.id === chatAgentId) : undefined;
  // Keep the last known info around so a brief die→refetch window doesn't
  // flash the overview; once the refetch confirms the container is really
  // gone (terminated — possibly from another device), the effect below
  // closes the chat instead of showing a dead one forever.
  const lastChatAgentRef = useRef<AgentInfo | null>(null);
  if (chatAgent) lastChatAgentRef.current = chatAgent;
  const shownChatAgent = chatAgent ?? lastChatAgentRef.current;

  // Close the open chat when its agent container disappears from the agent
  // list (removed after terminate — on any device). Only once the id has been
  // seen in a refetch: a just-started agent isn't in the first list yet, and
  // closing then would bounce the user straight out of the new chat.
  const everSeenRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const a of agents) everSeenRef.current.add(a.id);
    if (
      chatAgentId &&
      everSeenRef.current.has(chatAgentId) &&
      !agents.some((a) => a.id === chatAgentId)
    ) {
      lastChatAgentRef.current = null;
      setChatAgentId(null);
    }
  }, [agents, chatAgentId]);

  return (
    <div className="app-shell">
      <TabHeader tab={tab} onHome={goHome} />

      <main className="tab-content" data-tab={tab}>
        {tab === "agents" &&
          (chatAgentId && shownChatAgent ? (
            <Chat
              key={shownChatAgent.id}
              agent={shownChatAgent}
              onBack={() => setChatAgentId(null)}
              onTerminated={() => setChatAgentId(null)}
            />
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
                onOpenNotes={() => setTab("ide")}
                onStart={openStart}
                onStarted={(agent) => openChat(agent.id)}
              />
            </div>
          ))}

        {tab === "ide" && (
          <NotesViewer notesName={notesName} onBack={() => setTab("agents")} />
        )}

        {tab === "gc" && (
          <div className="overview">
            <div className="empty">
              <p>General Chat lives here.</p>
              <p className="dim">
                The ChatGPT-style chat over your notes arrives in a later phase —
                this tab proves the chrome routing first.
              </p>
            </div>
          </div>
        )}
      </main>

      <BottomNav tab={tab} onChange={setTab} />

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
    </div>
  );
}
