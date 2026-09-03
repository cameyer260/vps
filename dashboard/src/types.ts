// Shared frontend types (pi RPC JSONL shapes, agent/session models).

export interface AgentInfo {
  id: string;
  name: string;
  project: string;
  origin: string | null;
  state: string;
  startedAt: string | null;
  live: "idle" | "streaming" | "exited" | null;
  sessionName: string | null;
  model: string | null;
  thinkingLevel: string | null;
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
  | { kind: "user"; text: string; provisional: boolean }
  | {
      kind: "assistant";
      text: string[];
      thinking: string[];
      tools: ToolView[];
      done: boolean;
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
