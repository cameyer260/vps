import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useChat } from "../chat";
import type { AgentInfo } from "../types";
import { MessageView, ModelPicker } from "./MessageView";

interface Props {
  agent: AgentInfo;
  onBack: () => void;
  onTerminated: () => void;
}

export function Chat({ agent, onBack, onTerminated }: Props) {
  const chat = useChat(agent);
  const { state } = chat;
  const [input, setInput] = useState("");
  const [confirming, setConfirming] = useState(false);
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

  const terminate = async () => {
    try {
      await api.terminateAgent(agent.id);
    } catch {
      /* container may already be gone */
    }
    onTerminated();
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
          <button className="btn ghost danger" onClick={() => setConfirming(true)} aria-label="Terminate agent">
            ✕
          </button>
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

      {confirming && (
        <div className="modal-scrim" onClick={() => setConfirming(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Terminate agent?</h2>
            <p className="dim">
              Stops the container and removes it. The conversation stays in pi's session
              store and can be resumed later.
            </p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setConfirming(false)}>
                cancel
              </button>
              <button className="btn danger" onClick={terminate}>
                terminate
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
