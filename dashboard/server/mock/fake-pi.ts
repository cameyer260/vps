import { PassThrough, Writable } from "node:stream";
import fs from "node:fs";
import { config } from "../config.js";
import type { AttachedAgent } from "../runtime.js";

/**
 * FakePi — scripted `pi --mode rpc` stand-in for mock mode (mock-VPS plan,
 * Phase 2). One instance per agent session: owns the shared entry log,
 * creates per-attach stdio pipes, answers one JSONL command per line.
 *
 * Command/event catalog v1 is closed (§5.1 of the plan): get_state, set_model,
 * set_thinking_level, set_session_name, get_available_models,
 * get_available_thinking_levels, get_entries, prompt, abort. New pi event
 * types go through "extend catalog + add golden" later, not drive-by.
 *
 * Protocol notes (match `docs/rpc.md` + the bridge/client expectations):
 * - Every response echoes the command's `id` and names its `command`.
 * - `get_state` data: { model, thinkingLevel, sessionName, sessionFile }.
 * - `set_model` data is the full new model object (the bridge broadcasts the
 *   state notice off this).
 * - `get_available_models` data: { models }; `get_available_thinking_levels`
 *   data: { levels }.
 * - `get_entries` data: { entries, leafId }; unknown `since` → success false
 *   with error "unknown cursor" (exercises the client's full-reload fallback).
 * - Events fan out to ALL currently attached pipes; responses go only to the
 *   requesting pipe.
 * - Internal bridge requests (`get_state` with `i<n>` ids) are answered
 *   identically to client ones — the lazy-attach path depends on it.
 */

export type StreamGranularity = "char" | "word" | "instant";

export interface MockModel {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
}

export interface FakePiHistoryEntry {
  type: string;
  id?: string;
  [key: string]: unknown;
}

export interface FakePiOptions {
  id: string;
  project: string;
  name?: string;
  readOnly?: boolean;
  granularity?: StreamGranularity;
  models?: MockModel[];
  history?: FakePiHistoryEntry[];
}

const DEFAULT_MODEL: MockModel = {
  provider: "openrouter",
  id: "mock-sonnet",
  name: "Mock Sonnet",
};

const DEFAULT_LEVELS = ["low", "medium", "high"];

const READ_ONLY_ON_TEXT = "read-only mode is ON (/read-only off to disable)";

function sessionFileFor(id: string): string {
  return `${config.sessionsDir}/mock/${id}.jsonl`;
}

interface Attach {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: Writable;
}

export class FakePi {
  readonly id: string;
  readonly project: string;

  private model: MockModel = { ...DEFAULT_MODEL };
  private thinkingLevel = "medium";
  private sessionName: string;
  private readonly sessionFile: string;
  private readOnly: boolean;
  private readonly granularity: StreamGranularity;
  private readonly models: MockModel[];

  private entries: Array<Record<string, unknown>> = [];
  private leafId: string | null = null;
  private entrySeq = 0;

  private attaches = new Set<Attach>();
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private streaming = false;
  private pendingPrompt: { message: string } | null = null;
  private notifySeq = 0;
  private closed = false;

  constructor(opts: FakePiOptions) {
    this.id = opts.id;
    this.project = opts.project;
    this.sessionName = opts.name ?? "mock chat";
    this.sessionFile = sessionFileFor(opts.id);
    this.readOnly = !!opts.readOnly;
    this.granularity = opts.granularity ?? "word";
    this.models = opts.models && opts.models.length > 0 ? opts.models : [{ ...DEFAULT_MODEL }];
    // Seed with the default model only if the fixture list lacks it — the
    // model picker test asserts set_model round-trips, not catalog contents.
    if (opts.history) {
      for (const e of opts.history) {
        if (e && typeof e === "object" && typeof e.id === "string") {
          this.entries.push({ ...e });
          this.leafId = e.id;
          const m = /^e(\d+)$/.exec(e.id);
          if (m) this.entrySeq = Math.max(this.entrySeq, Number(m[1]));
        }
      }
    }
  }

  /** Load resume history from a pi session file: message/compaction entries
   *  (with ids) become the entry log; the name comes from the first
   *  session_info. Returns null when the file is unreadable. */
  static loadResume(sessionPath: string): { entries: FakePiHistoryEntry[]; name: string | null } | null {
    try {
      const raw = fs.readFileSync(sessionPath, "utf8");
      const entries: FakePiHistoryEntry[] = [];
      let name: string | null = null;
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(t) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (obj["type"] === "session_info" && name === null && typeof obj["name"] === "string") {
          name = obj["name"] as string;
        }
        if (
          (obj["type"] === "message" || obj["type"] === "compaction") &&
          typeof obj["id"] === "string"
        ) {
          entries.push(obj as FakePiHistoryEntry);
        }
      }
      return { entries, name };
    } catch {
      return null;
    }
  }

  createAttach(): AttachedAgent {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const self = this;
    let buf = "";
    const stdin = new Writable({
      write(chunk, _enc, cb) {
        buf += chunk.toString("utf8");
        for (;;) {
          const idx = buf.indexOf("\n");
          if (idx === -1) break;
          const line = buf.slice(0, idx).replace(/\r$/, "");
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            self.handleCommand(JSON.parse(line) as Record<string, unknown>, stdout);
          } catch {
            // unparseable input line — ignore (matches pi's tolerance)
          }
        }
        cb();
      },
    });
    const attach: Attach = { stdout, stderr, stdin };
    this.attaches.add(attach);
    const cleanup = () => {
      this.attaches.delete(attach);
    };
    stdout.on("close", cleanup);
    stdin.on("close", cleanup);
    if (this.closed) {
      // Attaching to a stopped agent: tear the new pipes straight down so
      // the bridge's markExited path fires, like a real stop.
      setTimeout(() => {
        try {
          (stdin as unknown as { destroy: () => void }).destroy();
        } catch {
          /* ignore */
        }
      }, 5).unref?.();
      return { stdin, stdout, stderr };
    }
    // Seed stderr so GET /api/agents/:id/logs renders something in mock mode.
    for (const line of this.stderrSeed()) {
      stderr.write(line + "\n");
    }
    // Startup notify (mirrors the real read-only extension's session_start,
    // which notifies only when starting read-only and stays silent
    // otherwise). Sent per attach so every bridge — including one lazily
    // attached after a dashboard restart — observes the mode.
    if (this.readOnly) {
      this.queueNotify(READ_ONLY_ON_TEXT, "info", stdout);
    }
    return { stdin, stdout, stderr };
  }

  /** Close all pipes (mock stop): drives the bridge's markExited path. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelTimers();
    for (const a of this.attaches) {
      try {
        a.stdout.end();
      } catch {
        /* ignore */
      }
      try {
        a.stderr.end();
      } catch {
        /* ignore */
      }
      try {
        (a.stdin as unknown as { destroy: () => void }).destroy();
      } catch {
        /* ignore */
      }
    }
    this.attaches.clear();
  }

  // ---- internals ----------------------------------------------------------

  private stderrSeed(): string[] {
    return [
      `fake-pi ready (${this.id})`,
      `project: ${this.project}`,
      `read-only: ${this.readOnly ? "on" : "off"}`,
    ];
  }

  private nextEntryId(): string {
    return `e${++this.entrySeq}`;
  }

  private appendEntry(entry: Record<string, unknown>): string {
    const id = typeof entry["id"] === "string" ? (entry["id"] as string) : this.nextEntryId();
    const withId = { ...entry, id };
    this.entries.push(withId);
    this.leafId = id;
    return id;
  }

  private emitTo(stdout: PassThrough, obj: unknown): void {
    if (this.closed) return;
    try {
      stdout.write(JSON.stringify(obj) + "\n");
    } catch {
      /* pipe gone */
    }
  }

  private broadcast(obj: unknown): void {
    for (const a of this.attaches) this.emitTo(a.stdout, obj);
  }

  private respond(
    stdout: PassThrough,
    cmd: Record<string, unknown>,
    success: boolean,
    data?: unknown,
    error?: string,
  ): void {
    const resp: Record<string, unknown> = {
      type: "response",
      command: cmd["type"],
      success,
    };
    if (typeof cmd["id"] === "string") resp["id"] = cmd["id"];
    if (success) {
      if (data !== undefined) resp["data"] = data;
    } else if (error !== undefined) {
      resp["error"] = error;
    }
    this.emitTo(stdout, resp);
  }

  private queueNotify(message: string, notifyType: string, only?: PassThrough): void {
    const note = {
      type: "extension_ui_request",
      id: `notify-${this.id}-${++this.notifySeq}`,
      method: "notify",
      message,
      notifyType,
    };
    // Defer a tick so the bridge has wired its stdout listener.
    const t = setTimeout(() => {
      if (only) this.emitTo(only, note);
      else this.broadcast(note);
    }, 5);
    (t as unknown as { unref?: () => void }).unref?.();
  }

  private handleCommand(cmd: Record<string, unknown>, stdout: PassThrough): void {
    if (this.closed) return;
    switch (cmd["type"]) {
      case "get_state": {
        this.respond(stdout, cmd, true, {
          model: { ...this.model },
          thinkingLevel: this.thinkingLevel,
          sessionName: this.sessionName,
          sessionFile: this.sessionFile,
        });
        return;
      }
      case "set_model": {
        const provider = cmd["provider"];
        const modelId = cmd["modelId"];
        if (typeof provider !== "string" || typeof modelId !== "string") {
          this.respond(stdout, cmd, false, undefined, "provider and modelId are required");
          return;
        }
        const found = this.models.find((m) => m.provider === provider && m.id === modelId);
        this.model = found ? { ...found } : { provider, id: modelId, name: modelId };
        // Response data is the full new model object (bridge broadcasts off this).
        this.respond(stdout, cmd, true, { ...this.model });
        return;
      }
      case "set_thinking_level": {
        const level = cmd["level"];
        if (typeof level !== "string") {
          this.respond(stdout, cmd, false, undefined, "level is required");
          return;
        }
        this.thinkingLevel = level;
        this.respond(stdout, cmd, true);
        return;
      }
      case "set_session_name": {
        const name = cmd["name"];
        if (typeof name !== "string") {
          this.respond(stdout, cmd, false, undefined, "name is required");
          return;
        }
        this.sessionName = name;
        this.respond(stdout, cmd, true);
        return;
      }
      case "get_available_models": {
        this.respond(stdout, cmd, true, { models: this.models.map((m) => ({ ...m })) });
        return;
      }
      case "get_available_thinking_levels": {
        this.respond(stdout, cmd, true, { levels: [...DEFAULT_LEVELS] });
        return;
      }
      case "get_entries": {
        const since = cmd["since"];
        if (typeof since === "string") {
          const idx = this.entries.findIndex((e) => e["id"] === since);
          if (idx === -1) {
            this.respond(stdout, cmd, false, undefined, "unknown cursor");
            return;
          }
          this.respond(stdout, cmd, true, {
            entries: this.entries.slice(idx + 1),
            leafId: this.leafId,
          });
          return;
        }
        this.respond(stdout, cmd, true, {
          entries: [...this.entries],
          leafId: this.leafId,
        });
        return;
      }
      case "prompt": {
        const message = cmd["message"];
        if (typeof message !== "string") {
          this.respond(stdout, cmd, false, undefined, "message is required");
          return;
        }
        // Slash commands execute immediately even mid-turn and start no turn.
        if (message.startsWith("/")) {
          this.handleSlash(message, cmd, stdout);
          return;
        }
        // images acked, ignored
        this.respond(stdout, cmd, true);
        if (this.streaming) {
          // Buffer at most one pending prompt; the client blocks these anyway
          // except slashes.
          this.pendingPrompt = { message };
          return;
        }
        this.runTurn(message);
        return;
      }
      case "abort": {
        this.cancelTimers();
        this.pendingPrompt = null;
        this.streaming = false;
        this.broadcast({ type: "agent_settled" });
        this.respond(stdout, cmd, true);
        return;
      }
      default: {
        this.respond(stdout, cmd, false, undefined, `unknown command: ${String(cmd["type"])}`);
        return;
      }
    }
  }

  private handleSlash(message: string, cmd: Record<string, unknown>, stdout: PassThrough): void {
    const m = /^\/read-only\s*(.*)$/i.exec(message.trim());
    if (!m) {
      // Other slash commands: ack, no turn (matches prod).
      this.respond(stdout, cmd, true);
      return;
    }
    const arg = (m[1] ?? "").trim().toLowerCase();
    if (arg === "on" || arg === "off") {
      this.readOnly = arg === "on";
      this.respond(stdout, cmd, true);
      // Exact text the bridge regexes (matches the real extension).
      this.queueNotify(`read-only mode ${arg}`, arg === "on" ? "info" : "warning");
      return;
    }
    this.respond(stdout, cmd, true);
    this.queueNotify("usage: /read-only on|off", "warning");
  }

  // ---- scripted turn ------------------------------------------------------

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      if (this.closed) return;
      fn();
      // After settle, run a buffered prompt if one arrived mid-turn.
      if (!this.streaming && this.pendingPrompt) {
        const next = this.pendingPrompt;
        this.pendingPrompt = null;
        this.runTurn(next.message);
      }
    }, ms);
    (t as unknown as { unref?: () => void }).unref?.();
    this.timers.push(t);
  }

  private cancelTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private runTurn(prompt: string): void {
    this.streaming = true;
    // Steps are [incrementalDelayMs, fn]: each fires that long after the
    // previous one, so text deltas stream at a steady cadence.
    const steps: Array<[number, () => void]> = [];
    const at = (ms: number, fn: () => void) => steps.push([ms, fn]);

    const userText = prompt;
    const prose =
      `Mock reply to: "${userText}"\n\n` +
      `This is a scripted reply. It echoes your prompt.`;
    const thinkingText = "Considering the request…";
    const toolArgs = { path: "notes/example.md" };
    const toolArgsJson = JSON.stringify(toolArgs);
    const toolResultText = `# notes/example.md (mock)\n\nScripted tool result.`;
    const fullAssistantText = `${prose}\n\nRead \`notes/example.md\` for context.`;

    // Entries committed as the turn fires (stable ids e1, e2, …).
    at(0, () => {
      this.broadcast({ type: "agent_start" });
    });
    at(5, () => {
      this.broadcast({ type: "message_start", message: { role: "user", content: userText } });
      this.appendEntry({ type: "message", message: { role: "user", content: userText } });
    });
    at(5, () => {
      this.broadcast({
        type: "message_start",
        message: { role: "assistant", content: [], model: this.model.id },
      });
    });

    // Streaming text deltas per granularity preset.
    const textDeltas = this.splitDeltas(prose);
    at(5, () => {
      this.broadcast({
        type: "message_update",
        assistantMessageEvent: { type: "text_start", contentIndex: 0 },
      });
    });
    for (const d of textDeltas.deltas) {
      const delta = d;
      at(textDeltas.perDeltaMs, () => {
        this.broadcast({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
        });
      });
    }

    // Short thinking block.
    at(5, () => {
      this.broadcast({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_start", contentIndex: 1 },
      });
    });
    at(10, () => {
      this.broadcast({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: thinkingText },
      });
    });
    at(10, () => {
      this.broadcast({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_end", contentIndex: 1 },
      });
    });

    // Tool call (id t1 identical across start/delta/end, execution events,
    // the toolResult entry, and the final assistant content's toolCall block —
    // the client matches results to spinners by it).
    at(5, () => {
      this.broadcast({
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_start", contentIndex: 2, id: "t1", toolName: "read" },
      });
    });
    at(10, () => {
      this.broadcast({
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2, id: "t1", delta: toolArgsJson },
      });
    });
    at(10, () => {
      this.broadcast({
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_end",
          contentIndex: 2,
          id: "t1",
          toolCall: { type: "toolCall", id: "t1", name: "read", arguments: toolArgs },
        },
      });
    });
    at(10, () => {
      this.broadcast({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: toolArgs });
    });
    at(15, () => {
      this.broadcast({
        type: "tool_execution_update",
        toolCallId: "t1",
        toolName: "read",
        args: toolArgs,
        partialResult: { content: [{ type: "text", text: toolResultText.slice(0, 24) }] },
      });
    });
    at(15, () => {
      this.broadcast({
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "read",
        result: { content: [{ type: "text", text: toolResultText }] },
        isError: false,
      });
    });
    at(10, () => {
      this.broadcast({
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: "t1",
          toolName: "read",
          content: [{ type: "text", text: toolResultText }],
        },
      });
      this.appendEntry({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "t1",
          toolName: "read",
          content: [{ type: "text", text: toolResultText }],
        },
      });
    });
    at(10, () => {
      this.broadcast({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: fullAssistantText },
            { type: "toolCall", id: "t1", name: "read", arguments: toolArgs },
          ],
          model: this.model.id,
        },
      });
      this.appendEntry({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: fullAssistantText },
            { type: "toolCall", id: "t1", name: "read", arguments: toolArgs },
          ],
          model: this.model.id,
        },
      });
    });
    at(10, () => {
      this.streaming = false;
      this.broadcast({ type: "agent_settled" });
    });

    // Schedule: cumulative delays so steps fire in order.
    let elapsed = 0;
    for (const [ms, fn] of steps) {
      elapsed += ms;
      this.later(elapsed, fn);
    }
  }

  private splitDeltas(text: string): { deltas: string[]; perDeltaMs: number } {
    switch (this.granularity) {
      case "char":
        return { deltas: [...text], perDeltaMs: 8 };
      case "instant":
        return { deltas: [text], perDeltaMs: 0 };
      case "word":
      default: {
        const parts = text.match(/\S+\s*/g) ?? [text];
        return { deltas: parts, perDeltaMs: 40 };
      }
    }
  }
}
