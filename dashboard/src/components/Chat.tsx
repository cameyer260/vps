import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "../chat";
import { api } from "../api";
import type { AgentInfo, SkillInfo } from "../types";
import { MessageView, ModelPicker } from "./MessageView";
import { TerminateButton } from "./TerminateButton";

interface Props {
  agent: AgentInfo;
  notesName: string;
  onBack: () => void;
  onTerminated: () => void;
}

export function Chat({ agent, notesName, onBack, onTerminated }: Props) {
  const chat = useChat(agent);
  const { state } = chat;
  const [input, setInput] = useState("");

  // Skill autocomplete: typing "/" as the first token lists available
  // skills (name + one-line description) so users never have to know exact
  // skill names upfront. Inserted as `/skill:<name>` — pi expands it.
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [skillIdx, setSkillIdx] = useState(0);
  const [dismissedToken, setDismissedToken] = useState<string | null>(null);
  useEffect(() => {
    api
      .skills()
      .then((r) => setSkills(r.skills))
      .catch(() => setSkills([]));
  }, []);

  const skillMatches = useMemo(() => {
    if (!input.startsWith("/") || /\s/.test(input)) return null;
    if (input === dismissedToken) return null;
    const q = input.slice(1).toLowerCase();
    const list = (skills ?? []).filter(
      (s) =>
        s.name.toLowerCase().startsWith(q) ||
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q),
    );
    return list.slice(0, 8);
  }, [input, skills, dismissedToken]);
  useEffect(() => setSkillIdx(0), [input, skills]);

  const acceptSkill = (name: string) => {
    setInput(`/skill:${name} `);
    setDismissedToken(null);
  };

  // Read-only toggle (dashboard extension). Ground truth is the agent: the
  // extension notifies on every mode change, the bridge relays those and
  // hands its last known state to new clients in `hello`. No localStorage —
  // per-device memory goes stale.
  const toggleReadOnly = () => {
    chat.send(`/read-only ${state.readOnly ? "off" : "on"}`);
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);

  const exited = state.status === "exited";

  // Keep the view pinned to the bottom while streaming, unless the user
  // scrolled up to read.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight;
  });

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const submit = () => {
    if (streaming) return; // no steer — Enter is ignored until the turn settles
    const text = input.trim();
    if (!text) return;
    chat.send(text);
    setInput("");
    setDismissedToken(null);
    nearBottomRef.current = true;
  };

  const streaming = state.status === "streaming";

  const onComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (skillMatches && skillMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSkillIdx((i) => (i + 1) % skillMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSkillIdx((i) => (i - 1 + skillMatches.length) % skillMatches.length);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissedToken(input);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        acceptSkill(skillMatches[Math.min(skillIdx, skillMatches.length - 1)]!.name);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="chat">
      <header className="chat-head">
        <button className="btn ghost back" onClick={onBack} aria-label="Back">
          ←
        </button>
        <div className="chat-title">
          <span className="chat-name">{state.sessionName || agent.sessionName || agent.name || "agent"}</span>
          <span className="chat-sub">
            {agent.project}
            <span className={`dot ${streaming ? "streaming" : exited ? "dead" : "idle"}`} />
            {streaming ? "streaming" : exited ? "exited" : state.connected ? "idle" : "connecting…"}
            {state.queued.followUp > 0 && ` · ${state.queued.followUp} queued`}
          </span>
        </div>
        <div className="chat-controls">
          <button
            className={`ro-toggle${state.readOnly ? " on" : ""}`}
            onClick={toggleReadOnly}
            disabled={exited}
            title="Read-only mode: edit/write tools disabled and mutating bash commands blocked (/read-only on|off)"
          >
            read-only {state.readOnly ? "on" : "off"}
          </button>
          <ModelPicker
            models={state.models}
            current={state.model}
            onPick={(provider, id) => chat.setModel(provider, id)}
          />
          {state.thinkingLevels && state.thinkingLevels.length > 1 && (
            <select
              className="select small"
              value={state.thinkingLevel ?? "off"}
              onChange={(e) => chat.setThinkingLevel(e.target.value)}
              title="Thinking level"
            >
              {state.thinkingLevels.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          )}
          {!exited && (
            <TerminateButton agent={agent} notesName={notesName} onTerminated={onTerminated} />
          )}
        </div>
      </header>

      <div className="chat-messages" ref={scrollRef} onScroll={onScroll}>
        <div className="messages-inner">
          {state.items.map((item, i) => (
            <MessageView key={i} item={item} />
          ))}
          {state.items.length === 0 && state.connected && (
            <div className="empty">
              <p>Say something to this agent.</p>
              <p className="dim">It runs in its own container, scoped to {agent.project}.</p>
            </div>
          )}
        </div>
      </div>

      <div className="notices">
        {state.notices.map((n) => (
          <div key={n.id} className={`notice ${n.level}`}>
            {n.text}
          </div>
        ))}
      </div>

      {exited ? (
        <div className="composer exited">
          <span className="dim">This agent has exited.</span>
        </div>
      ) : (
        <div className="composer">
          {skillMatches && skillMatches.length > 0 && (
            <div className="skill-pop" role="listbox" aria-label="Skill suggestions">
              <div className="skill-pop-head">skills — Tab/Enter to insert, Esc to dismiss</div>
              {skillMatches.map((s, i) => (
                <button
                  key={s.name}
                  type="button"
                  className={`skill-row${i === Math.min(skillIdx, skillMatches.length - 1) ? " active" : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    acceptSkill(s.name);
                  }}
                  onMouseEnter={() => setSkillIdx(i)}
                >
                  <span className="skill-name">/{s.name}</span>
                  <span className="skill-desc">{s.description || "skill"}</span>
                </button>
              ))}
            </div>
          )}
          <textarea
            value={input}
            placeholder={streaming ? "agent is running — stop it to send…" : "message the agent… ( / for skills)"}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onComposerKeyDown}
            rows={1}
          />
          {streaming ? (
            <button className="btn stop send-btn" onClick={() => chat.abort()} title="Stop" aria-label="Stop">
              ■
            </button>
          ) : (
            <button className="btn primary send-btn" onClick={submit} disabled={!input.trim()} title="Send" aria-label="Send">
              ↑
            </button>
          )}
        </div>
      )}
    </div>
  );
}
