import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { AgentInfo, SessionSummary } from "../types";
import { ChatView } from "./ChatView";
import { ReadOnlyToggle } from "./ReadOnlyToggle";
import { TreeModal, type TreeModalItem } from "./TreeModal";
import { statusDot, uptime } from "./AgentsSections";

/**
 * General Chat tab (spec §6): a ChatGPT-clone over the notes dir.
 *
 * Chrome per the sketch (4.jpg): `Dashboard - General Chat` (global
 * TabHeader) + a sub-header row — `Conversations` hamburger (opens the
 * conversation list in the shared TreeModal shell over notes-dir sessions)
 * + `ReadOnlyToggle` starting **on** (author decision 2026-09-11, overriding
 * the sketch margin note). The chat body reuses the shared `ChatView`
 * (spec §7.1: message rendering, streaming, auto-grow composer with send ↑
 * always visible but disabled when empty, image attach, skill autocomplete,
 * backfill/reconnect) with its header hidden — the GC sub-header above is
 * the single header, so exactly one toggle is ever visible.
 *
 * Launch = a notes-dir agent with the GC system prompt (phase 6
 * `generalChat` flag, read-only default; mid-chat toggle via `/read-only`
 * through the sub-header toggle, wired to the same agent ground truth as
 * the agent-chat toggle — no second socket). Conversation switching =
 * spawn/resume via the existing session source (`GET /api/sessions` +
 * `POST /api/agents/start`); tapping a running notes agent attaches to it,
 * tapping a past session (or New) spawns a GC agent (resuming when a
 * session file is picked). No-chat state mirrors the IDE no-selection
 * pattern (empty + buttons → modal). Tap-to-home (App `homeSignal`) returns
 * here. Termination rides the Agents tab (GC agents are dashboard agents at
 * the notes project); when the active container vanishes elsewhere this
 * view drops back to the list home like the agent chat does.
 */

interface Props {
  agents: AgentInfo[];
  notesName: string;
  /** Active GC agent id — owned by App so tab switches keep it (like the
   *  agent-chat id); null = conversation list home. */
  activeId: string | null;
  onActiveChange: (id: string | null) => void;
  homeSignal: number;
}

export function GeneralChat({ agents, notesName, activeId, onActiveChange, homeSignal }: Props) {
  const [convOpen, setConvOpen] = useState(false);
  // GC starts read-only/on by default (spec §6) — this is the default for
  // the *next* spawn while no chat is open.
  const [defaultReadOnly, setDefaultReadOnly] = useState(true);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  // Live toggle mirror for the open chat (fed by ChatView's agent-observed
  // state — same ground truth, no second socket). Initialized false to match
  // useChat's pre-hello state; hello flips GC spawns on immediately.
  const [liveReadOnly, setLiveReadOnly] = useState(false);
  const liveToggleRef = useRef<(() => void) | null>(null);
  // Provisional agent info so a just-spawned chat renders instantly (the
  // global agents refetch lands ~250ms later via /ws/events).
  const [provisional, setProvisional] = useState<AgentInfo | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const goListHome = () => {
    onActiveChange(null);
    setProvisional(null);
    setConvOpen(false);
    setStartError(null);
  };

  // Tap `Dashboard` in the header homes *within* the GC tab: back to the
  // conversation list home (spec §2). Same prev-value guard as IdeView so
  // mount (incl. StrictMode double-invoke) is a no-op.
  const prevHome = useRef(homeSignal);
  useEffect(() => {
    if (prevHome.current === homeSignal) return;
    prevHome.current = homeSignal;
    goListHome();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeSignal]);

  // Drop back to the list home when the active container vanishes from the
  // agent list (terminated — possibly from another device / the Agents tab).
  // The ever-seen guard keeps a just-spawned id alive until its first
  // refetch, mirroring App's agent-chat close logic.
  const everSeenRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const a of agents) everSeenRef.current.add(a.id);
    if (activeId && everSeenRef.current.has(activeId) && !agents.some((a) => a.id === activeId)) {
      onActiveChange(null);
      setProvisional(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, activeId]);

  // Sessions back the Past section of the conversations modal.
  useEffect(() => {
    if (!convOpen || !notesName) return;
    let alive = true;
    setSessions(null);
    api
      .sessions(notesName)
      .then((r) => alive && setSessions(r.sessions))
      .catch(() => alive && setSessions([]));
    return () => {
      alive = false;
    };
  }, [convOpen, notesName]);

  const activeReal = activeId ? agents.find((a) => a.id === activeId) ?? null : null;
  const activeAgent = activeReal ?? (activeId && provisional?.id === activeId ? provisional : null);
  const exited = activeReal?.live === "exited";

  /** Spawn a GC agent (fresh, or resuming a notes session) and open it. */
  const startGc = async (sessionPath: string | null) => {
    setStarting(true);
    setStartError(null);
    try {
      const resume = !!sessionPath;
      const now = new Date();
      const res = await api.startAgent({
        project: notesName,
        ...(resume
          ? { sessionPath: sessionPath as string }
          : {
              name: `gc ${now.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`,
            }),
        readOnly: defaultReadOnly,
        generalChat: true,
      });
      // Optimistic live-toggle: we know what we requested, hello confirms.
      setLiveReadOnly(defaultReadOnly);
      setProvisional({
        id: res.id,
        name: res.id.slice(0, 12),
        project: res.project,
        origin: "dashboard",
        state: "running",
        startedAt: new Date().toISOString(),
        live: null,
        sessionName: null,
        model: null,
        thinkingLevel: null,
      });
      onActiveChange(res.id);
      setConvOpen(false);
    } catch (e) {
      setStartError(`couldn't start chat: ${String((e as Error).message ?? e)}`);
    } finally {
      setStarting(false);
    }
  };

  // Running notes conversations (every dashboard agent at the notes project
  // *is* a conversation in the notes dir) + past notes sessions.
  const running = agents
    .filter((a) => a.project === notesName && a.origin === "dashboard")
    .sort((x, y) => (y.startedAt ?? "").localeCompare(x.startedAt ?? ""));

  const sessionTitle = (s: SessionSummary): string =>
    s.name ?? s.preview ?? "session " + s.id.slice(0, 8);

  const convItems: TreeModalItem[] = [
    { key: "__new__", title: "New conversation", subtitle: "fresh chat over notes" },
    ...(running.length > 0
      ? [
          {
            key: "__running__",
            title: `Running (${running.length})`,
            defaultExpanded: true,
            children: running.map((a) => {
              const dot = statusDot(a);
              return {
                key: `agent:${a.id}`,
                title: (
                  <span className="gc-row-title">
                    <span className={`dot ${dot.cls}`} aria-hidden="true" />
                    {a.sessionName || a.name || a.id.slice(0, 12)}
                  </span>
                ),
                subtitle: `${uptime(a.startedAt)} · ${dot.label}`,
              };
            }),
          } satisfies TreeModalItem,
        ]
      : []),
    ...((sessions ?? []).length > 0
      ? [
          {
            key: "__past__",
            title: `Past (${(sessions ?? []).length})`,
            defaultExpanded: running.length === 0,
            children: (sessions ?? []).map((s) => ({
              key: `session:${s.file}`,
              title: sessionTitle(s),
              subtitle:
                (s.timestamp ? new Date(s.timestamp).toLocaleString() : "") +
                (s.timestamp && s.preview && s.preview !== s.name ? " — " : "") +
                (s.preview && s.preview !== s.name ? s.preview : ""),
            })),
          } satisfies TreeModalItem,
        ]
      : []),
  ];

  const selectConversation = (item: TreeModalItem) => {
    if (item.key === "__new__") {
      void startGc(null);
      return;
    }
    if (item.key.startsWith("agent:")) {
      const id = item.key.slice("agent:".length);
      setLiveReadOnly(false); // hello/state resyncs; GC spawns flip on
      setProvisional(null);
      onActiveChange(id);
      setConvOpen(false);
      return;
    }
    if (item.key.startsWith("session:")) {
      const hit = sessions?.find((s) => `session:${s.file}` === item.key);
      if (hit) void startGc(hit.file);
    }
  };

  const toggleSubHeader = activeAgent
    ? () => liveToggleRef.current?.()
    : () => setDefaultReadOnly((v) => !v);

  return (
    <div className="notes gc">
      <header className="notes-head gc-subheader">
        <button
          className="btn ghost gc-conv-btn"
          onClick={() => setConvOpen(true)}
          aria-label="Conversations"
          title="Conversations — all chats in the notes dir"
        >
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
          <span className="gc-conv-label">Conversations</span>
        </button>
        <span className="notes-title gc-title" title={activeReal?.sessionName ?? activeAgent?.name ?? ""}>
          {activeAgent ? (activeReal?.sessionName || activeAgent.sessionName || activeAgent.name || "chat") : ""}
        </span>
        <ReadOnlyToggle
          value={activeAgent ? liveReadOnly : defaultReadOnly}
          onToggle={toggleSubHeader}
          disabled={activeAgent ? exited : false}
          title={
            activeAgent
              ? "Read-only mode: edit/write tools disabled and mutating bash commands blocked (/read-only on|off)"
              : "New chats start read-only (toggle in chat any time)"
          }
        />
      </header>

      <div className="notes-body">
        <div className="notes-main">
          {!activeAgent ? (
            <div className="empty gc-home">
              <p>No conversation open, pick one</p>
              <p className="dim">General chat over your notes — read-only by default.</p>
              <div className="gc-home-actions">
                <button className="btn" onClick={() => setConvOpen(true)}>
                  Conversations
                </button>
                <button className="btn primary" onClick={() => void startGc(null)} disabled={starting}>
                  {starting ? "starting…" : "New conversation"}
                </button>
              </div>
              {startError && <div className="error-box">{startError}</div>}
            </div>
          ) : (
            <ChatView
              key={activeAgent.id}
              agent={activeAgent}
              onBack={goListHome}
              onTerminated={goListHome}
              hideHeader
              onReadOnlyState={(value, toggle) => {
                setLiveReadOnly(value);
                liveToggleRef.current = toggle;
              }}
            />
          )}
        </div>
      </div>

      {convOpen && (
        <TreeModal
          title="Conversations"
          items={convItems}
          emptyText={sessions === null ? "loading…" : "no conversations yet"}
          footer={
            <div className="ide-search-foot">
              {startError && <span className="gc-modal-error">{startError}</span>}
              {starting ? (
                <span className="dim">starting…</span>
              ) : (
                sessions === null && <span className="dim">loading sessions…</span>
              )}
            </div>
          }
          onClose={() => {
            if (!starting) setConvOpen(false);
          }}
          onSelect={selectConversation}
        />
      )}
    </div>
  );
}
