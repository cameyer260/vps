import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "../chat";
import { api } from "../api";
import type { AgentInfo, AttachmentView, SkillInfo } from "../types";
import type { PromptImage } from "../chat";
import { MessageView, ModelPicker } from "./MessageView";
import { TerminateButton } from "./TerminateButton";

interface PendingFile {
  id: string;
  file: File;
  previewUrl?: string; // object URL for images
}

const TEXT_FILE_RE = /^(text\/|application\/json|application\/xml|application\/javascript|application\/x-yaml|application\/toml)/i;
const TEXT_EXT_RE = /\.(md|txt|json|csv|tsv|ya?ml|toml|xml|html?|css|js|jsx|ts|tsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|sh|bash|zsh|sql|ini|cfg|conf|env|log|diff|patch)$/i;

function isImageFile(f: File): boolean {
  return f.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name);
}

function isTextFile(f: File): boolean {
  return TEXT_FILE_RE.test(f.type) || TEXT_EXT_RE.test(f.name) || f.type === "";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1 << 20) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1 << 20)).toFixed(1)} MB`;
}

function base64ToUtf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

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
  // Attachments: picked files are uploaded on send (server enforces the size
  // cap); images ride the RPC prompt's images field, text-like files are
  // inlined as fenced blocks so model and UI see the same content.
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [preparing, setPreparing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    return () => {
      for (const p of pendingFiles) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const next: PendingFile[] = [];
    for (const file of files) {
      if (!isImageFile(file) && !isTextFile(file)) continue; // silently skip unsupported
      next.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        previewUrl: isImageFile(file) ? URL.createObjectURL(file) : undefined,
      });
    }
    if (next.length === 0) return;
    setPendingFiles((p) => [...p, ...next]);
  };

  const removePending = (id: string) => {
    setPendingFiles((p) => {
      const hit = p.find((f) => f.id === id);
      if (hit?.previewUrl) URL.revokeObjectURL(hit.previewUrl);
      return p.filter((f) => f.id !== id);
    });
  };

  const submit = async () => {
    if (streaming || preparing) return; // no steer — Enter is ignored until the turn settles
    const text = input.trim();
    if (!text && pendingFiles.length === 0) return;

    if (pendingFiles.length === 0) {
      chat.send(text);
    } else {
      setPreparing(true);
      try {
        const uploads = await Promise.all(pendingFiles.map((p) => api.upload(p.file)));
        const images: PromptImage[] = [];
        let message = text;
        for (const u of uploads) {
          if (u.image) {
            images.push({ type: "image", data: u.data, mimeType: u.mimeType });
          } else {
            message += `\n\n[attached file: ${u.name}]\n\`\`\`\n${base64ToUtf8(u.data)}\n\`\`\``;
          }
        }
        const attachments: AttachmentView[] = uploads.map((u) => ({
          name: u.name,
          mimeType: u.mimeType,
          size: u.size,
          image: u.image,
        }));
        chat.send(message || "(see attachments)", images.length > 0 ? images : undefined, attachments);
        for (const p of pendingFiles) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
        setPendingFiles([]);
        setInput("");
        setDismissedToken(null);
        nearBottomRef.current = true;
      } catch (err) {
        chat.notice(`upload failed: ${String((err as Error).message ?? err)}`, "error");
      } finally {
        setPreparing(false);
      }
      return;
    }
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
      void submit();
    }
  };

  return (
    <div className="chat">
      <header className="chat-head">
        <button className="btn ghost back" onClick={onBack} aria-label="Back">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M19 12H5m7-7-7 7 7 7" />
          </svg>
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
          {pendingFiles.length > 0 && (
            <div className="pending-files">
              {pendingFiles.map((p) => (
                <span key={p.id} className="pending-file">
                  {p.previewUrl ? (
                    <img src={p.previewUrl} alt={p.file.name} className="pending-thumb" />
                  ) : (
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                    </svg>
                  )}
                  <span className="pending-name" title={p.file.name}>{p.file.name}</span>
                  <span className="pending-size">{formatSize(p.file.size)}</span>
                  <button
                    type="button"
                    className="pending-remove"
                    onClick={() => removePending(p.id)}
                    aria-label={`Remove ${p.file.name}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,.md,.txt,.json,.csv,.tsv,.yaml,.yml,.toml,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.rb,.go,.rs,.java,.c,.h,.cpp,.sh,.sql,.log,.diff,.patch"
            className="visually-hidden"
            tabIndex={-1}
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = ""; // allow re-picking the same file
            }}
          />
          <button
            type="button"
            className="btn ghost attach-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={streaming || preparing}
            title="Attach images or text files"
            aria-label="Attach files"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <textarea
            value={input}
            placeholder={streaming ? "agent is running — stop it to send…" : "message the agent… ( / for skills)"}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onComposerKeyDown}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (files.length > 0) {
                e.preventDefault();
                addFiles(e.clipboardData.files);
              }
            }}
            rows={1}
          />
          {streaming ? (
            <button className="btn stop send-btn" onClick={() => chat.abort()} title="Stop" aria-label="Stop">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          ) : (
            <button
              className="btn primary send-btn"
              onClick={() => void submit()}
              disabled={(!input.trim() && pendingFiles.length === 0) || preparing}
              title={preparing ? "Uploading…" : "Send"}
              aria-label={preparing ? "Uploading" : "Send"}
            >
              {preparing ? (
                "…"
              ) : (
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 19V5m-7 7 7-7 7 7" />
                </svg>
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
