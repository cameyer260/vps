import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { AgentInfo } from "./types";
import { AgentsSections } from "./components/AgentsSections";
import { Chat } from "./components/Chat";
import { GeneralChat } from "./components/GeneralChat";
import { IdeView, IdeHeaderActions, type IdeHeaderState } from "./components/IdeView";
import { StartDialog } from "./components/StartDialog";
import { TabHeader } from "./components/TabHeader";
import { BottomNav, type TabKey } from "./components/BottomNav";

export default function App() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [tab, setTab] = useState<TabKey>("agents");
  // Bumped to home the IDE tab (back to its no-selection state). Tab
  // switches unmount/remount IdeView and keep the persisted project — only
  // an explicit Dashboard tap clears it.
  const [ideHome, setIdeHome] = useState(0);
  // General Chat's open conversation (null = conversation list home). Kept
  // in App so tab switches preserve it, like the agent-chat id; the GC
  // view drops it when its container vanishes.
  const [gcAgentId, setGcAgentId] = useState<string | null>(null);
  const [gcHome, setGcHome] = useState(0);
  // IDE TabHeader actions descriptor published by IdeView (null off-tab).
  const [ideHeader, setIdeHeader] = useState<IdeHeaderState | null>(null);
  const handleIdeHeader = useCallback((h: IdeHeaderState | null) => setIdeHeader(h), []);
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
    // Group F: one delayed resync after boot. Session names (the only
    // titles we show — never docker container names) arrive via lazy
    // bridge attach + get_state, which the initial fetches can beat; this
    // picks them up without polling.

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
    const lateResync = setTimeout(() => alive && refetch(), 2500);

    return () => {
      alive = false;
      if (retry) clearTimeout(retry);
      if (refetchDelay) clearTimeout(refetchDelay);
      clearTimeout(lateResync);
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
  // returns to the overview; IDE returns to its no-selection state (via
  // IdeView's homeSignal); GC returns to its conversation list home (via
  // GeneralChat's homeSignal).
  const goHome = useCallback(() => {
    if (tab === "agents") setChatAgentId(null);
    else if (tab === "ide") setIdeHome((n) => n + 1);
    else if (tab === "gc") setGcHome((n) => n + 1);
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
      <TabHeader
        tab={tab}
        onHome={goHome}
        onStart={!chatAgentId && tab === "agents" ? () => openStart() : undefined}
        actions={
          tab === "ide" && ideHeader ? <IdeHeaderActions header={ideHeader} /> : undefined
        }
      />

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
              <AgentsSections
                agents={agents}
                notesName={notesName}
                onOpenChat={openChat}
                onStart={openStart}
              />
            </div>
          ))}

        {tab === "ide" && <IdeView homeSignal={ideHome} onHeader={handleIdeHeader} />}

        {tab === "gc" && (
          <GeneralChat
            agents={agents}
            notesName={notesName}
            activeId={gcAgentId}
            onActiveChange={setGcAgentId}
            homeSignal={gcHome}
          />
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
