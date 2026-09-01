import { useEffect, useRef, useState } from "react";
import { useChat } from "../chat";
import type { AgentInfo } from "../types";
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

  // Read-only toggle (dashboard extension): notes agents start read-only.
  // Remember the last state per container so reattaching shows the truth as
  // this device knows it.
  const [readOnly, setReadOnly] = useState<boolean | null>(() => {
    const stored = localStorage.getItem(`ro:${agent.id}`);
    if (stored !== null) return stored === "1";
    return agent.project === notesName ? true : false;
  });
  const toggleReadOnly = () => {
    const next = !(readOnly ?? false);
    setReadOnly(next);
    localStorage.setItem(`ro:${agent.id}`, next ? "1" : "0");
    chat.send(`/read-only ${next ? "on" : "off"}`);
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
    const text = input.trim();
    if (!text) return;
    chat.send(text);
    setInput("");
    nearBottomRef.current = true;
  };

  const streaming = state.status === "streaming";

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
            {state.queued.steer > 0 && ` · ${state.queued.steer} queued`}
          </span>
        </div>
        <div className="chat-controls">
          <button
            className={`ro-toggle${readOnly ? " on" : ""}`}
            onClick={toggleReadOnly}
            disabled={exited}
            title="Read-only mode: edit/write tools disabled and mutating bash commands blocked (/read-only on|off)"
          >
            read-only {readOnly ? "on" : "off"}
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
          <textarea
            value={input}
            placeholder={streaming ? "steer: send while it's running…" : "message the agent…"}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
          />
          {streaming && (
            <button className="btn stop" onClick={() => chat.abort()} title="Abort">
              ■ stop
            </button>
          )}
          <button className="btn primary send" onClick={submit} disabled={!input.trim()}>
            {streaming ? "steer" : "send"}
          </button>
        </div>
      )}
    </div>
  );
}
