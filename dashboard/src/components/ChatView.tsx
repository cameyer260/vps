import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "../chat";
import { api } from "../api";
import type { AgentInfo, AttachmentView, SkillInfo, UploadedFile } from "../types";
import type { PromptImage } from "../chat";
import { MessageView } from "./MessageView";
import { ReadOnlyToggle } from "./ReadOnlyToggle";
import { SessionInfoPopover } from "./SessionInfoPopover";
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
  onBack: () => void;
  onTerminated: () => void;
  /** General Chat renders its own sub-header (Conversations + toggle per
   *  the sketch) and reuses only the messages/composer below — the
   *  ChatView header (back/title/model/terminate) stays agent-chat-only. */
  hideHeader?: boolean;
  /** Mirror of the live read-only mode for an external toggle (GC
   *  sub-header): called whenever the agent-observed value changes. */
  onReadOnlyState?: (value: boolean, toggle: () => void) => void;
}

/**
 * Shared chat UI (spec §7.1): one chat view for both agent chats and General
 * Chat — message rendering, streaming states, auto-grow composer, skill
 * autocomplete, backfill/reconnect (via useChat), attachments, notices.
 * Only the launch context (project agent vs notes-dir GC agent + system
 * prompt) differs; that stays with the caller.
 *
 * Phase 2 is an extraction without behavior change: `Chat` is a thin
 * wrapper over this (GC reuses it in phase 7).
 */
export function ChatView({ agent, onBack, onTerminated, hideHeader, onReadOnlyState }: Props) {
  const chat = useChat(agent);
  const { state } = chat;
  const isHost = agent.runtime === "host";
  const [input, setInput] = useState("");
  const [composing, setComposing] = useState(false);
  // Header info modal (ⓘ left of the power button): model, effort, and
  // session stats live here now — the chat-head row keeps title + icons.
  const [infoOpen, setInfoOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  // Overlay layout: the header and composer float above the full-bleed
  // message scroll, so the scroll pads its content clear of them via
  // --chat-head-h / --composer-h on the .chat root. ResizeObserver keeps
  // the vars live across textarea growth, safe-area, and keyboard shifts;
  // no header (GC) measures as 0.
  // While the composer is focused the software keyboard is up: flag the
  // document so the global bottom pill can hide and the composer can sit
  // right above the keyboard (Group C). Cleared on blur/unmount so the
  // pill shows at all other times.
  useEffect(() => {
    document.documentElement.classList.toggle("chat-typing", composing);
    return () => document.documentElement.classList.remove("chat-typing");
  }, [composing]);

  // Auto-grow composer (ChatGPT-style): the textarea grows with its content
  // up to the CSS max-height, then scrolls internally instead of clipping.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    el.style.overflowY = el.scrollHeight > el.clientHeight + 1 ? "auto" : "hidden";
  }, [input]);

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
  // Attachments popover: the paperclip toggles a floating panel (badge
  // shows the count) instead of an inline strip, so the composer can fade
  // to transparent with nothing opaque sitting in the fade zone. Paste /
  // picker only bump the badge — the panel never auto-opens.
  const [attachOpen, setAttachOpen] = useState(false);
  const attachPopRef = useRef<HTMLDivElement>(null);
  const attachBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!attachOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (attachPopRef.current?.contains(t)) return;
      if (attachBtnRef.current?.contains(t)) return;
      setAttachOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAttachOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [attachOpen]);
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

  // Let an embedding page (GC) drive its own sub-header toggle off the
  // same ground truth — no second socket, no local state. The parent
  // renders `ReadOnlyToggle` with this value/toggle; this view hides its
  // own header toggle via `hideHeader` so exactly one toggle is visible.
  const readOnlyCb = useRef(onReadOnlyState);
  readOnlyCb.current = onReadOnlyState;
  useEffect(() => {
    readOnlyCb.current?.(state.readOnly, toggleReadOnly);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.readOnly]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);

  const exited = state.status === "exited";

  // Overlay layout (see the --chat-head-h comment above): measure the two
  // floating bars into CSS vars so the full-bleed scroll pads clear.
  // Re-runs when the header/composer nodes swap (hideHeader, exited);
  // ResizeObserver covers textarea growth, safe-area, and keyboard shifts.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      root.style.setProperty("--chat-head-h", `${headRef.current?.offsetHeight ?? 0}px`);
      root.style.setProperty("--composer-h", `${composerRef.current?.offsetHeight ?? 80}px`);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (headRef.current) ro.observe(headRef.current);
    if (composerRef.current) ro.observe(composerRef.current);
    return () => ro.disconnect();
  }, [hideHeader, exited]);

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
      if (!isImageFile(file) && !isTextFile(file)) {
        chat.notice(`unsupported file: ${file.name} — attach images or text files`, "error");
        continue;
      }
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

    // First-message titling (Group F): fresh agents are unnamed — never a
    // docker container name. The first user message becomes the session
    // title (persisted via set_session_name so lists pick it up too).
    const untitled =
      !state.sessionName && !agent.sessionName && state.items.length === 0;
    const titleForFirst = () => {
      if (!untitled) return;
      const firstLine = (text || pendingFiles[0]?.file.name || "")
        .split("\n")[0]!
        .trim();
      if (firstLine) chat.setSessionName(firstLine);
    };

    if (pendingFiles.length === 0) {
      chat.send(text);
      titleForFirst();
      setAttachOpen(false);
    } else {
      setPreparing(true);
      try {
        // Upload per-file so a failure can name the file. Nothing is sent
        // unless every upload succeeds — pending chips and typed text survive.
        const results = await Promise.allSettled(pendingFiles.map((p) => api.upload(p.file)));
        const failures = results
          .map((r, i) => ({ r, file: pendingFiles[i]!.file }))
          .filter((x) => x.r.status === "rejected");
        if (failures.length > 0) {
          for (const { r, file } of failures) {
            const reason = (r as PromiseRejectedResult).reason;
            chat.notice(`upload failed: ${file.name} — ${String((reason as Error)?.message ?? reason)}`, "error");
          }
          return;
        }
        const uploads = (results as PromiseFulfilledResult<UploadedFile>[]).map((r) => r.value);
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
        titleForFirst();
        setAttachOpen(false);
        for (const p of pendingFiles) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
        setPendingFiles([]);
        setInput("");
        setDismissedToken(null);
        nearBottomRef.current = true;
      } catch (err) {
        chat.notice(`failed to send message: ${String((err as Error).message ?? err)}`, "error");
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

  // The attach button is disabled while streaming, so it can't toggle the
  // panel closed — drop the panel the moment a turn starts instead.
  useEffect(() => {
    if (streaming) setAttachOpen(false);
  }, [streaming]);

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
    <div ref={rootRef} className={`chat${hideHeader ? " gc-chat" : ""}`}>
      {!hideHeader && (
      <header ref={headRef} className="chat-head">
        <button className="btn ghost chat-head-btn back" onClick={onBack} aria-label="Back">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M19 12H5m7-7-7 7 7 7" />
          </svg>
        </button>
        <span
          className={`dot chat-dot ${streaming ? "streaming" : exited ? "dead" : "idle"}`}
          aria-hidden="true"
          title={streaming ? "streaming" : exited ? "exited" : state.connected ? "idle" : "connecting"}
        />
        {isHost && (
          <span className="jarvis-off-pill" title={agent.directory ?? "bare-metal host pi"}>
            jarvis off
          </span>
        )}
        <div className="chat-spacer" aria-hidden="true" />
        <div className="chat-controls">
          <button
            className="btn ghost chat-head-btn info-btn"
            onClick={() => setInfoOpen(true)}
            title="Model, effort & session info"
            aria-label="Session info"
            aria-haspopup="dialog"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 11v5" />
              <path d="M12 8h.01" />
            </svg>
          </button>
          {!exited && <TerminateButton agent={agent} onTerminated={onTerminated} />}
        </div>
        {infoOpen && (
          <SessionInfoPopover
            model={state.model}
            models={state.models}
            thinkingLevel={state.thinkingLevel}
            thinkingLevels={state.thinkingLevels}
            status={state.status}
            exited={exited}
            onPickModel={(provider, id) => chat.setModel(provider, id)}
            onPickThinkingLevel={(level) => chat.setThinkingLevel(level)}
            onStats={() => chat.getSessionStats()}
            onClose={() => setInfoOpen(false)}
          />
        )}
      </header>
      )}
      {/* Read-only floats below the header, right-aligned over the
          messages — no border extension, no extra header height (Group C).
          Host agents load no read-only extension, so they carry no toggle. */}
      {!hideHeader && !isHost && (
        <div className="chat-ro-float">
          <ReadOnlyToggle
            value={state.readOnly}
            onToggle={toggleReadOnly}
            disabled={exited}
          />
        </div>
      )}

      <div className="chat-messages" ref={scrollRef} onScroll={onScroll}>
        <div className="messages-inner">
          {state.items.map((item, i) => (
            <MessageView key={i} item={item} />
          ))}
          {state.items.length === 0 && state.connected && (hideHeader ? (
            <div className="empty">
              <p>What do you want to talk about?</p>
            </div>
          ) : (
            <div className="empty">
              <p>Say something to this agent.</p>
              {isHost ? (
                <p className="dim host-warn">Runs on the host with full dev permissions{agent.directory ? ` in ${agent.directory}` : ""} — no container isolation.</p>
              ) : (
                <p className="dim">It runs in its own container, scoped to {agent.project}.</p>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="notices">
        {/* GC hides its header and carries its own read-only toggle, so the
            transient "read-only mode is ON" notify is redundant noise there
            (Group F feedback) — agent chats keep the full rail. */}
        {(hideHeader
          ? state.notices.filter((n) => !/read-only mode/i.test(n.text))
          : state.notices
        ).map((n) => (
          <div key={n.id} className={`notice ${n.level}`}>
            {n.text}
          </div>
        ))}
      </div>

      {exited ? (
        <div ref={composerRef} className="composer exited">
          <span className="dim">This agent has exited.</span>
        </div>
      ) : (
        <div ref={composerRef} className="composer">
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
          {attachOpen && (
            <div className="attach-pop" ref={attachPopRef} role="dialog" aria-label="Attached files">
              <div className="attach-pop-head">
                <span>Attached · {pendingFiles.length}</span>
                <button
                  type="button"
                  className="attach-pop-close"
                  onClick={() => setAttachOpen(false)}
                  aria-label="Close attachments"
                >
                  ×
                </button>
              </div>
              {pendingFiles.length > 0 && (
                <div className="attach-list">
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
              <button
                type="button"
                className="btn attach-add"
                onClick={() => fileInputRef.current?.click()}
                disabled={streaming || preparing}
              >
                + Add photos or files
              </button>
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
            ref={attachBtnRef}
            type="button"
            className="btn ghost attach-btn"
            onClick={() => setAttachOpen((v) => !v)}
            disabled={streaming || preparing}
            title="Attach images or text files"
            aria-label={pendingFiles.length > 0 ? `Attached files, ${pendingFiles.length} attached` : "Attach files"}
            aria-haspopup="dialog"
            aria-expanded={attachOpen}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
            {pendingFiles.length > 0 && (
              <span className="attach-count" aria-hidden="true">{pendingFiles.length}</span>
            )}
          </button>
          <textarea
            ref={taRef}
            value={input}
            aria-label="Message the agent"
            onChange={(e) => setInput(e.target.value)}
            onFocus={() => setComposing(true)}
            onBlur={() => setComposing(false)}
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
              <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor" aria-hidden="true">
                <rect x="2" y="2" width="20" height="20" rx="5" />
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
