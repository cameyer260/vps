import { useEffect, useMemo, useReducer, useRef } from "react";
import type {
  AgentInfo,
  AssistantMessageEvent,
  AttachmentView,
  ContentBlock,
  Item,
  Notice,
  PiEntry,
  PiEvent,
  PiMessage,
  PiModel,
  ToolView,
} from "./types";

/**
 * Client side of the WS→RPC bridge. Maintains rendered chat items from two
 * sources: `get_entries` backfills (durable, id-cursored) and live pi RPC
 * events (transient). Items created from live events are "provisional" — on
 * every backfill they are dropped and replaced by their committed entries, so
 * reconnects never duplicate or lose conversation content.
 */

export interface ChatState {
  items: Item[];
  cursor: string | null; // last committed entry id we know about
  entryIds: Record<string, true>;
  status: "connecting" | "idle" | "streaming" | "exited";
  connected: boolean;
  readOnly: boolean; // agent's read-only mode (ground truth: extension notifies)
  model: PiModel | null;
  thinkingLevel: string | null;
  sessionName: string | null;
  models: PiModel[] | null;
  thinkingLevels: string[] | null;
  queued: { steer: number; followUp: number };
  notices: Notice[];
}

const initialState: ChatState = {
  items: [],
  cursor: null,
  entryIds: {},
  status: "connecting",
  connected: false,
  readOnly: false,
  model: null,
  thinkingLevel: null,
  sessionName: null,
  models: null,
  thinkingLevels: null,
  queued: { steer: 0, followUp: 0 },
  notices: [],
};

// ---- helpers ----------------------------------------------------------------

function contentToBlocks(msg: PiMessage): {
  text: string[];
  thinking: string[];
  tools: ToolView[];
} {
  const text: string[] = [];
  const thinking: string[] = [];
  const tools: ToolView[] = [];
  if (typeof msg.content === "string") {
    if (msg.content) text.push(msg.content);
  } else {
    for (const block of msg.content) {
      if (block.type === "text" && block.text) text.push(block.text);
      else if (block.type === "thinking" && block.thinking) thinking.push(block.thinking);
      else if (block.type === "toolCall")
        tools.push({
          id: block.id,
          name: block.name,
          argsText: prettyArgs(block.arguments),
          running: false,
          output: null,
          result: null,
        });
    }
  }
  return { text, thinking, tools };
}

function prettyArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function blocksToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as ContentBlock[])
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n\n");
}

/** Attachment chips derivable from a pi user message (live echo or
 *  committed entry): image content blocks + the message's attachments list. */
function userAttachments(msg: PiMessage): AttachmentView[] | undefined {
  const out: AttachmentView[] = [];
  if (Array.isArray(msg.content)) {
    for (const b of msg.content as ContentBlock[]) {
      if (b.type === "image") {
        out.push({ name: "image", mimeType: (b as { mimeType?: string }).mimeType ?? "image/png", image: true });
      }
    }
  }
  for (const a of msg.attachments ?? []) {
    const image = (a.mimeType ?? "").startsWith("image/");
    if (image && out.some((x) => x.image && x.name === (a.fileName ?? "image"))) continue;
    out.push({ name: a.fileName ?? (image ? "image" : "file"), mimeType: a.mimeType ?? "application/octet-stream", size: a.size, image });
  }
  return out.length > 0 ? out : undefined;
}

function resultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

function streamingAssistant(items: Item[]): {
  item: Extract<Item, { kind: "assistant" }>;
  index: number;
} | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === "assistant" && !item.done) return { item, index: i };
  }
  return null;
}

function findTool(items: Item[], toolCallId: string): ToolView | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === "assistant") {
      const tool = item.tools.find((t) => t.id === toolCallId);
      if (tool) return tool;
    }
  }
  return null;
}

function stripTrailingProvisional(items: Item[]): Item[] {
  let end = items.length;
  while (end > 0) {
    const item = items[end - 1];
    // An in-flight assistant message is still receiving live deltas — the
    // backfill must not strip it, or streaming text vanishes mid-turn.
    if (item.kind === "assistant" && !item.done) break;
    if (
      (item.kind === "user" || item.kind === "assistant" || item.kind === "toolresult") &&
      "provisional" in item &&
      item.provisional
    ) {
      end--;
    } else {
      break;
    }
  }
  return items.slice(0, end);
}

// ---- event application ------------------------------------------------------

type Action =
  | { type: "connected"; value: boolean }
  | { type: "status"; value: ChatState["status"] }
  | { type: "read_only"; value: boolean }
  | { type: "agent_event"; event: PiEvent }
  | { type: "backfill"; entries: PiEntry[]; full: boolean }
  | { type: "state"; data: Record<string, unknown> }
  | { type: "models"; models: PiModel[] }
  | { type: "thinking_levels"; levels: string[] }
  | { type: "sent_local"; text: string; attachments?: AttachmentView[] }
  | { type: "notice"; text: string; level?: Notice["level"] }
  | { type: "exited" };

function nextNoticeId(): string {
  return `n${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
}

function applyEvent(state: ChatState, event: PiEvent): ChatState {
  switch (event.type) {
    case "agent_start":
      return { ...state, status: "streaming" };

    case "agent_settled":
      return { ...state, status: "idle" };

    case "message_start": {
      const msg = event.message;
      if (!msg) return state;
      if (msg.role === "assistant") {
        const item: Item = {
          kind: "assistant",
          text: [],
          thinking: [],
          tools: [],
          done: false,
          model: msg.model ?? null,
          provisional: true,
        };
        return { ...state, items: [...state.items, item] };
      }
      if (msg.role === "user") {
        const text = blocksToText(msg.content).trim();
        if (!text || text.startsWith("/")) return state;
        const last = state.items[state.items.length - 1];
        if (last?.kind === "user" && last.text === text) return state;
        return {
          ...state,
          items: [...state.items, { kind: "user", text, provisional: true, attachments: userAttachments(msg) }],
        };
      }
      return state;
    }

    case "message_update": {
      const e = event.assistantMessageEvent as AssistantMessageEvent | undefined;
      if (!e) return state;
      let found = streamingAssistant(state.items);
      let items = state.items;
      if (!found) {
        // Attached mid-turn (or the streaming item was lost in a reconnect):
        // synthesize the in-flight assistant item on a block start so deltas
        // keep streaming instead of being dropped until message_end. Stray
        // deltas without a block start have nothing to attach to.
        if (e.type !== "text_start" && e.type !== "thinking_start" && e.type !== "toolcall_start") {
          return state;
        }
        const created: Extract<Item, { kind: "assistant" }> = {
          kind: "assistant",
          text: [],
          thinking: [],
          tools: [],
          done: false,
          model: null,
          provisional: true,
        };
        items = [...items, created];
        found = { item: created, index: items.length - 1 };
      }
      const item = { ...found.item, text: [...found.item.text], thinking: [...found.item.thinking], tools: [...found.item.tools] };
      items = [...items];
      items[found.index] = item;
      switch (e.type) {
        case "text_start":
          if (item.lastBlock === "text" && item.text.length > 0) break; // continuation
          item.text.push("");
          item.lastBlock = "text";
          break;
        case "text_delta":
          if (item.text.length === 0) item.text.push("");
          item.text[item.text.length - 1] += e.delta ?? "";
          item.lastBlock = "text";
          break;
        case "thinking_start":
          item.thinking.push("");
          item.lastBlock = "thinking";
          break;
        case "thinking_delta":
          if (item.thinking.length === 0) item.thinking.push("");
          item.thinking[item.thinking.length - 1] += e.delta ?? "";
          item.lastBlock = "thinking";
          break;
        case "toolcall_start":
          item.tools.push({
            id: e.id ?? `t${item.tools.length}`,
            name: e.toolName ?? "tool",
            argsText: "",
            running: true,
            output: null,
            result: null,
          });
          item.lastBlock = "tool";
          break;
        case "toolcall_delta": {
          const tool = item.tools[item.tools.length - 1];
          if (tool) tool.argsText += e.delta ?? "";
          break;
        }
        case "toolcall_end": {
          const tool = item.tools[item.tools.length - 1];
          if (tool && e.toolCall) tool.argsText = prettyArgs(e.toolCall.arguments);
          break;
        }
      }
      return { ...state, items };
    }

    case "message_end": {
      const msg = event.message;
      if (!msg) return state;
      if (msg.role === "assistant") {
        const blocks = contentToBlocks(msg);
        const found = streamingAssistant(state.items);
        const item: Extract<Item, { kind: "assistant" }> = {
          kind: "assistant",
          ...blocks,
          done: true,
          model: msg.model ?? null,
          provisional: true,
        };
        if (found) {
          const items = [...state.items];
          items[found.index] = item;
          return { ...state, items };
        }
        // No streaming item (e.g. we attached mid-turn): append the final one.
        return { ...state, items: [...state.items, item] };
      }
      if (msg.role === "toolResult") {
        const tool = findTool(state.items, msg.toolCallId ?? "");
        const result = { text: resultText(msg.content), isError: !!msg.isError };
        if (tool) {
          tool.result = result;
          tool.running = false;
          return { ...state, items: [...state.items] };
        }
        return {
          ...state,
          items: [
            ...state.items,
            { kind: "toolresult", toolCallId: msg.toolCallId ?? "", toolName: msg.toolName ?? "tool", text: result.text, isError: result.isError, provisional: true } as Item,
          ],
        };
      }
      return state;
    }

    case "tool_execution_start": {
      const tool = findTool(state.items, event.toolCallId ?? "");
      if (!tool) return state;
      tool.running = true;
      if (!tool.argsText.trim()) tool.argsText = prettyArgs(event.args);
      return { ...state, items: [...state.items] };
    }

    case "tool_execution_update": {
      const tool = findTool(state.items, event.toolCallId ?? "");
      if (!tool) return state;
      tool.output = resultText(event.partialResult?.content);
      return { ...state, items: [...state.items] };
    }

    case "tool_execution_end": {
      const tool = findTool(state.items, event.toolCallId ?? "");
      if (!tool) return state;
      tool.running = false;
      tool.result = { text: resultText(event.result?.content), isError: !!event.isError };
      return { ...state, items: [...state.items] };
    }

    case "queue_update":
      return {
        ...state,
        queued: { steer: event.steering?.length ?? 0, followUp: event.followUp?.length ?? 0 },
      };

    case "extension_ui_request": {
      if (event.method === "notify") {
        // notify's `message` is plain text, not a pi message object
        return pushNotice(state, String(event.message ?? ""), (event.notifyType as Notice["level"]) ?? "info");
      }
      return state;
    }

    case "extension_error":
      return pushNotice(state, `extension error: ${event.error ?? "unknown"}`, "error");

    case "auto_retry_start":
      return pushNotice(state, `retrying (attempt ${event.attempt}): ${event.errorMessage ?? ""}`, "warning");

    default:
      return state;
  }
}

function pushNotice(state: ChatState, text: string, level: Notice["level"]): ChatState {
  const notice: Notice = { id: nextNoticeId(), text, level };
  const notices = [...state.notices, notice].slice(-20);
  return { ...state, notices };
}

function entryToItems(state: ChatState, entry: PiEntry): { items: Item[]; id?: string } {
  const items: Item[] = [];
  if (entry.type === "message" && entry.message) {
    const msg = entry.message;
    if (msg.role === "user") {
      const text = blocksToText(msg.content).trim();
      // A reconnect keeps the in-flight turn's provisional user message (it
      // precedes the still-streaming assistant item); skip the committed copy
      // so the backfill doesn't duplicate it.
      const keptProvisional = state.items.some(
        (it) => it.kind === "user" && it.provisional && it.text === text,
      );
      if (text && !keptProvisional)
        items.push({ kind: "user", text, provisional: false, attachments: userAttachments(msg) });
    } else if (msg.role === "assistant") {
      items.push({
        kind: "assistant",
        ...contentToBlocks(msg),
        done: true,
        model: msg.model ?? null,
        provisional: false,
      });
    } else if (msg.role === "toolResult") {
      const tool = findTool(state.items, msg.toolCallId ?? "");
      const result = { text: resultText(msg.content), isError: !!msg.isError };
      if (tool) {
        tool.result = result;
        tool.running = false;
      } else {
        items.push({
          kind: "toolresult",
          toolCallId: msg.toolCallId ?? "",
          toolName: msg.toolName ?? "tool",
          text: result.text,
          isError: result.isError,
          provisional: false,
        });
      }
    }
  } else if (entry.type === "compaction" && entry.summary) {
    items.push({ kind: "compaction", summary: entry.summary });
  }
  return { items, id: entry.id };
}

function applyBackfill(state: ChatState, entries: PiEntry[], full: boolean): ChatState {
  let items = full ? [] : stripTrailingProvisional(state.items);
  let entryIds = full ? {} : { ...state.entryIds };
  let cursor = state.cursor;
  for (const entry of entries) {
    if (!entry.id) continue;
    if (entryIds[entry.id]) continue;
    entryIds[entry.id] = true;
    const { items: newItems } = entryToItems({ ...state, items }, entry);
    if (newItems.length) items = [...items, ...newItems];
    cursor = entry.id;
  }
  return { ...state, items, entryIds, cursor };
}

function reducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case "connected":
      return { ...state, connected: action.value, status: action.value ? "idle" : "connecting" };
    case "status":
      return { ...state, status: action.value };
    case "read_only":
      return { ...state, readOnly: action.value };
    case "agent_event":
      return applyEvent(state, action.event);
    case "backfill":
      return applyBackfill(state, action.entries, action.full);
    case "state": {
      // Partial merge: get_state sends everything; bridge state notices after
      // set_model / set_thinking_level / set_session_name send one field, so
      // all tabs of a chat stay in sync without refetching.
      const data = action.data;
      let { model, thinkingLevel, sessionName } = state;
      if ("model" in data) {
        const m = data["model"] as PiModel | null | undefined;
        model = m ? { provider: m.provider, id: m.id, name: m.name } : null;
      }
      if ("thinkingLevel" in data) thinkingLevel = (data["thinkingLevel"] as string | undefined) ?? null;
      if ("sessionName" in data) sessionName = (data["sessionName"] as string | undefined) ?? null;
      return { ...state, model, thinkingLevel, sessionName };
    }
    case "models":
      return { ...state, models: action.models };
    case "thinking_levels":
      return { ...state, thinkingLevels: action.levels };
    case "sent_local": {
      const last = state.items[state.items.length - 1];
      if (last?.kind === "user" && last.text === action.text) return state;
      return {
        ...state,
        items: [...state.items, { kind: "user", text: action.text, provisional: true, attachments: action.attachments }],
      };
    }
    case "notice":
      return pushNotice(state, action.text, action.level ?? "info");
    case "exited":
      return { ...state, status: "exited" };
    default:
      return state;
  }
}

// ---- hook --------------------------------------------------------------------

export interface PromptImage {
  type: "image";
  data: string; // base64
  mimeType: string;
}

interface ChatApi {
  state: ChatState;
  send: (text: string, images?: PromptImage[], attachments?: AttachmentView[]) => void;
  abort: () => void;
  setModel: (provider: string, modelId: string) => void;
  setThinkingLevel: (level: string) => void;
  /** Push a client-side notice into the chat's notice rail. */
  notice: (text: string, level?: Notice["level"]) => void;
}

export function useChat(agent: AgentInfo): ChatApi {
  const [state, dispatch] = useReducer(reducer, initialState);
  const wsRef = useRef<WebSocket | null>(null);
  const cursorRef = useRef<string | null>(null);
  const modeRef = useRef<"full" | "since">("full");
  const lastReqRef = useRef<string>("");
  const reqIdRef = useRef(0);
  const pendingRef = useRef(new Map<string, (resp: Record<string, unknown>) => void>());
  const aliveRef = useRef(true);
  const stateRef = useRef(state);

  stateRef.current = state;
  cursorRef.current = state.cursor;

  const sendRaw = useMemo(() => {
    return (obj: unknown) => {
      wsRef.current?.send(JSON.stringify(obj));
    };
  }, []);

  const command = (cmd: Record<string, unknown>): Promise<Record<string, unknown>> => {
    return new Promise((resolve, reject) => {
      const id = `u${++reqIdRef.current}`;
      pendingRef.current.set(id, resolve);
      sendRaw({ type: "cmd", command: { ...cmd, id } });
      setTimeout(() => {
        if (pendingRef.current.delete(id)) reject(new Error(`no response for ${String(cmd.type)}`));
      }, 15_000);
    });
  };

  /** Request a history backfill. With a cursor we get only new entries;
   *  otherwise a full snapshot that replaces everything. */
  const backfill = (mode: "full" | "since") => {
    modeRef.current = mode;
    const reqId = `b${++reqIdRef.current}`;
    lastReqRef.current = reqId;
    sendRaw({
      type: "backfill",
      reqId,
      ...(mode === "since" && cursorRef.current ? { since: cursorRef.current } : {}),
    });
  };

  useEffect(() => {
    aliveRef.current = true;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const handleMessage = (raw: string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }
      const type = msg["type"];
      if (type === "hello") {
        // Cached state from the bridge: read-only mode (absent when it never
        // observed a notify — the start-time default is off) and model /
        // thinking / session info, so a reconnecting tab renders a correct
        // header instantly. The client's own get_state below stays the
        // authoritative refresh.
        if (typeof msg["readOnly"] === "boolean") {
          dispatch({ type: "read_only", value: msg["readOnly"] as boolean });
        }
        const st = msg["state"];
        if (st && typeof st === "object") {
          dispatch({ type: "state", data: st as Record<string, unknown> });
        }
        return;
      }
      if (type === "read_only") {
        // The bridge derives this from the read-only extension's notifies —
        // the button's ground truth while connected.
        if (typeof msg["value"] === "boolean") {
          dispatch({ type: "read_only", value: msg["value"] as boolean });
        }
        return;
      }
      if (type === "backfill") {
        if (msg["reqId"] !== lastReqRef.current) return; // stale response
        const entries = (msg["entries"] as PiEntry[] | undefined) ?? [];
        if (msg["success"] !== true) {
          if (modeRef.current === "since") {
            backfill("full"); // cursor rejected (unknown entry) — reload everything
          } else {
            dispatch({ type: "notice", text: `backfill failed: ${String(msg["error"] ?? "unknown")}`, level: "error" });
          }
          return;
        }
        dispatch({ type: "backfill", entries, full: modeRef.current === "full" });
        return;
      }
      if (type === "response") {
        const id = msg["id"] as string | undefined;
        const waiter = id ? pendingRef.current.get(id) : undefined;
        if (waiter) {
          pendingRef.current.delete(id!);
          waiter(msg);
        }
        if (msg["success"] === false) {
          dispatch({ type: "notice", text: `${msg["command"]}: ${msg["error"] ?? "failed"}`, level: "error" });
        }
        return;
      }
      if (type === "agent") {
        dispatch({ type: "agent_event", event: msg["event"] as PiEvent });
        return;
      }
      if (type === "status") {
        dispatch({ type: "status", value: msg["status"] as ChatState["status"] });
        return;
      }
      if (type === "exited") {
        dispatch({ type: "exited" });
        return;
      }
      if (type === "bridge_error") {
        dispatch({ type: "notice", text: String(msg["error"]), level: "error" });
      }
    };

    const connect = () => {
      if (!aliveRef.current) return;
      dispatch({ type: "connected", value: false });
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws/agent/${agent.id}`);
      wsRef.current = ws;
      ws.onopen = () => {
        dispatch({ type: "connected", value: true });
        backfill(cursorRef.current ? "since" : "full");
        // Prime UI state.
        command({ type: "get_state" })
          .then((resp) => {
            if (resp["success"]) dispatch({ type: "state", data: resp["data"] as Record<string, unknown> });
          })
          .catch(() => {});
        command({ type: "get_available_models" })
          .then((resp) => {
            const data = resp["data"] as { models?: PiModel[] } | undefined;
            if (data?.models) dispatch({ type: "models", models: data.models });
          })
          .catch(() => {});
        command({ type: "get_available_thinking_levels" })
          .then((resp) => {
            const data = resp["data"] as { levels?: string[] } | undefined;
            if (data?.levels) dispatch({ type: "thinking_levels", levels: data.levels });
          })
          .catch(() => {});
      };
      ws.onmessage = (e) => handleMessage(String(e.data));
      ws.onclose = (e) => {
        wsRef.current = null;
        for (const [, waiter] of pendingRef.current) waiter({ success: false, error: "disconnected" });
        pendingRef.current.clear();
        if (!aliveRef.current) return;
        if (e.code === 1008) {
          // The server refused the attach: the container is gone (or was
          // never a pi agent). Retrying can never succeed — surface the
          // terminal state instead of spinning on "connecting…".
          dispatch({ type: "exited" });
          return;
        }
        retry = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws.close();
    };

    connect();

    return () => {
      aliveRef.current = false;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);

  const api = useMemo<ChatApi>(
    () => ({
      state,
      send: (text: string, images?: PromptImage[], attachments?: AttachmentView[]) => {
        // No steering: while a turn runs the composer doesn't send. Slash
        // commands still go through — pi executes extension commands
        // immediately even mid-turn (that's how /read-only toggles).
        if (stateRef.current.status === "streaming" && !text.startsWith("/")) return;
        if (!text.startsWith("/")) dispatch({ type: "sent_local", text, attachments });
        command({
          type: "prompt",
          message: text,
          ...(images && images.length > 0 ? { images } : {}),
        }).catch((err) =>
          dispatch({ type: "notice", text: String(err.message ?? err), level: "error" }),
        );
      },
      abort: () => {
        command({ type: "abort" }).catch(() => {});
      },
      setModel: (provider: string, modelId: string) => {
        command({ type: "set_model", provider, modelId })
          .then((resp) => {
            if (resp["success"]) {
              dispatch({ type: "state", data: { model: resp["data"] } });
              dispatch({ type: "notice", text: `model → ${provider}/${modelId}` });
            }
          })
          .catch(() => {});
      },
      setThinkingLevel: (level: string) => {
        command({ type: "set_thinking_level", level })
          .then((resp) => {
            if (resp["success"]) {
              dispatch({ type: "state", data: { thinkingLevel: level } });
              dispatch({ type: "notice", text: `thinking → ${level}` });
            }
          })
          .catch(() => {});
      },
      notice: (text: string, level?: Notice["level"]) =>
        dispatch({ type: "notice", text, level }),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state],
  );

  return api;
}
