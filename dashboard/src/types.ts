// Shared frontend types (pi RPC JSONL shapes, agent/session models).

export interface SkillInfo {
  name: string;
  description: string;
}

/** Chat attachment as shown on a sent message. */
export interface AttachmentView {
  name: string;
  mimeType: string;
  size?: number;
  image?: boolean;
}

/** Result of POST /api/upload. */
export interface UploadedFile extends AttachmentView {
  data: string; // base64
}

export interface AgentInfo {
  id: string;
  name: string;
  project: string;
  origin: string | null;
  state: string;
  startedAt: string | null;
  live: "idle" | "streaming" | "exited" | null;
  sessionName: string | null;
  /** General Chat conversation agent (notes-dir ephemeral chat). Present
   *  when the runtime reports the `agent.generalchat` label; older agents
   *  predate the label and read undefined (treated as project agents). */
  generalChat?: boolean | null;
  model: string | null;
  thinkingLevel: string | null;
  /** Spawn path: jarvis containers vs bare-metal host pi (docs/host-pi.md). */
  runtime?: "jarvis" | "host" | null;
  /** Full host directory for host agents; null for jarvis containers. */
  directory?: string | null;
}

export interface SessionSummary {
  file: string;
  id: string;
  name: string | null;
  timestamp: string | null;
  mtime: number;
  preview: string | null;
}

export interface TreeNode {
  name: string;
  path: string;
  type: "dir" | "file";
  children?: TreeNode[];
  /** File renderer hint from the IDE backend (Phase 4); absent on old shapes. */
  kind?: "md" | "csv" | "text" | "binary";
  /** Git-ignored paths render greyed out (VS Code style). */
  ignored?: boolean;
  size?: number;
  mtime?: number;
}

// ---- pi messages / entries ----

export interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "image"; data?: string; mimeType?: string }
  | ToolCallBlock;

export interface PiMessage {
  role: "user" | "assistant" | "toolResult";
  content: string | ContentBlock[];
  provider?: string;
  model?: string;
  stopReason?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  attachments?: Array<{ fileName?: string; mimeType?: string; size?: number }>;
}

export interface PiEntry {
  type: string;
  id?: string;
  message?: PiMessage;
  summary?: string;
}

export interface PiModel {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
}

/** Token/cost/context stats from pi `get_session_stats` (shape per
 *  docs/rpc.md). `contextUsage` is omitted when no model or context window
 *  is available, and its tokens/percent are null right after compaction
 *  until a fresh post-compaction response lands — every field is optional
 *  so the UI can render graceful `—` states. */
export interface SessionStats {
  sessionFile?: string;
  sessionId?: string;
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
  toolResults?: number;
  totalMessages?: number;
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  cost?: number;
  contextUsage?: {
    tokens?: number | null;
    contextWindow?: number;
    percent?: number | null;
  } | null;
}

export interface PiEvent {
  type: string;
  message?: PiMessage;
  assistantMessageEvent?: AssistantMessageEvent;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  partialResult?: { content?: Array<{ type: string; text?: string }> };
  result?: { content?: Array<{ type: string; text?: string }> };
  isError?: boolean;
  steering?: string[];
  followUp?: string[];
  // extension_ui_request (notify pass-through)
  method?: string;
  notifyType?: string;
  error?: string;
  attempt?: number;
  errorMessage?: string;
  willRetry?: boolean;
}

export interface AssistantMessageEvent {
  type:
    | "text_start"
    | "text_delta"
    | "text_end"
    | "thinking_start"
    | "thinking_delta"
    | "thinking_end"
    | "toolcall_start"
    | "toolcall_delta"
    | "toolcall_end";
  contentIndex?: number;
  delta?: string;
  id?: string;
  toolName?: string;
  toolCall?: ToolCallBlock;
}

// ---- chat items (rendered) ----

export interface ToolView {
  id: string;
  name: string;
  argsText: string;
  running: boolean;
  output: string | null;
  result: { text: string; isError: boolean } | null;
}

export type Item =
  | { kind: "user"; text: string; provisional: boolean; attachments?: AttachmentView[] }
  | {
      kind: "assistant";
      text: string[];
      thinking: string[];
      tools: ToolView[];
      done: boolean;
      /** Turn ended without message_end (abort): the streamed prefix is final. */
      stopped?: boolean;
      model: string | null;
      provisional: boolean;
      lastBlock?: "text" | "thinking" | "tool";
    }
  | { kind: "toolresult"; toolCallId: string; toolName: string; text: string; isError: boolean; provisional?: boolean }
  | { kind: "compaction"; summary: string };

export interface Notice {
  id: string;
  text: string;
  level: "info" | "warning" | "error";
}
