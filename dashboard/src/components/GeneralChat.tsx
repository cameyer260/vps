import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { AgentInfo, SessionSummary } from "../types";
import { ChatView } from "./ChatView";
import { ReadOnlyToggle } from "./ReadOnlyToggle";
import { TreeModal, type TreeModalItem } from "./TreeModal";

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
 * here. GC agents never appear in the Agents tab — the open id lives in App
 * (RAM + localStorage restore across PWA reloads, validated against the
 * agent list on boot), and chats abandoned with no tabs attached are
 * terminated by the server-side idle reaper (server/gc-reaper.ts). When the
 * active container vanishes elsewhere this view drops back to the list home
 * like the agent chat does.
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

  /** Best-effort close for the ephemeral GC lifecycle (fire-and-forget:
   *  the container may already be gone — 404s are fine). */
  const closeQuietly = (id: string) => {
    api.terminateAgent(id).catch(() => {});
  };

  const goListHome = () => {
    // Leaving the chat closes the agent off (ephemeral conversations).
    // Tab switches keep it: activeId lives in App and unmount never closes.
    if (activeId) closeQuietly(activeId);
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

  /** Spawn a GC agent (fresh, or resuming a notes session) and open it.
   *  Fresh spawns are unnamed — no docker container names, no timestamp
   *  names. The first user message titles the conversation. */
  const startGc = async (sessionPath: string | null) => {
    setStarting(true);
    setStartError(null);
    try {
      const res = await api.startAgent({
        project: notesName,
        ...(sessionPath ? { sessionPath } : {}),
        readOnly: defaultReadOnly,
        generalChat: true,
      });
      // Optimistic live-toggle: we know what we requested, hello confirms.
      setLiveReadOnly(defaultReadOnly);
      const leaving = activeId;
      setProvisional({
        id: res.id,
        name: "",
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
      // Ephemeral handoff: the chat we just left closes behind us.
      if (leaving && leaving !== res.id) closeQuietly(leaving);
      setConvOpen(false);
    } catch (e) {
      setStartError(`couldn't start chat: ${String((e as Error).message ?? e)}`);
    } finally {
      setStarting(false);
    }
  };

  // Flat conversation list: just the pi sessions for the notes dir. No
  // Running/Past headers, no expanders (Group F feedback) — conversations
  // are ephemeral, so there is no running section to manage.
  const sessionTitle = (s: SessionSummary): string =>
    s.name ?? s.preview ?? "session " + s.id.slice(0, 8);

  const convItems: TreeModalItem[] = [
    { key: "__new__", title: "New conversation" },
    ...(sessions ?? []).map((s) => ({
      key: `session:${s.file}`,
      title: sessionTitle(s),
      subtitle:
        (s.timestamp ? new Date(s.timestamp).toLocaleString() : "") +
        (s.timestamp && s.preview && s.preview !== s.name ? " — " : "") +
        (s.preview && s.preview !== s.name ? s.preview : ""),
    })),
  ];

  const selectConversation = (item: TreeModalItem) => {
    if (item.key === "__new__") {
      void startGc(null);
      return;
    }
    if (item.key.startsWith("agent:")) {
      // Legacy path (the picker no longer lists running agents): attach
      // while closing whatever chat we leave behind.
      const id = item.key.slice("agent:".length);
      const leaving = activeId;
      setLiveReadOnly(false); // hello/state resyncs; GC spawns flip on
      setProvisional(null);
      onActiveChange(id);
      if (leaving && leaving !== id) closeQuietly(leaving);
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
        <span className="notes-title gc-title">
          {/* No name at the top of the open chat (Group F): titles live in
              the conversation list and the Agents tab. */}
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
