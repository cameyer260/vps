//! Bridge: one per agent, owning its pi RPC attachment and chat state.
//!
//! Port of `dashboard/server/bridge.ts` (plus the status/rename relay half
//! of `server/events.ts`). The TypeScript bridge was a dumb pipe — browsers
//! held the chat state machine and rendered Markdown client-side. The Rust
//! bridge inverts that (ADR 0003): it owns entry state, renders every entry
//! to sanitized HTML server-side ([`crate::markdown`]), and streams updates
//! as SSE events (`init` / `entry` / `delta` / `status` / `notice`). Deltas
//! are coalesced (~75ms) and the client just swaps fragments.
//!
//! Behavior preserved from the old bridge:
//! - Browser disconnects never stop the agent; history comes from the
//!   server-owned entry log, so reconnects replay `init` + `entry` events.
//! - Read-only ground truth is the extension's notifies, cached for late
//!   joiners (`init` carries it).
//! - Blocking dialog requests (`select`/`confirm`/`input`/`editor`) are
//!   dropped headlessly — with a `notice` telling the chat they were.
//! - `set_model` / `set_thinking_level` / `set_session_name` refresh the
//!   cached state and fan out so every tab stays in sync; renames also hit
//!   the global hub (same path as lifecycle events).
//! - `destroy()` (dashboard-initiated stop) broadcasts `exited` first, so
//!   chats open on other devices render the exit instead of idling forever.
//! - Committed entries come from `get_entries` (seed at attach, reconcile
//!   after every turn); live pi events only drive the streaming `delta`
//!   overlay and the optimistic user echo. No provisional/committed duality
//!   leaks to clients: entries carry stable pi ids, deltas are ephemeral.
//!
//! Locking: plain `std` mutexes held briefly and never across `.await`
//! (the pi pump, reconciles, and HTTP handlers only ever await channel or
//! socket IO with no lock held).

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{
    Arc, Mutex, RwLock,
    atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
};
use std::time::{Duration, Instant};

use axum::{
    Form, Json, Router,
    extract::{Path, State},
    http::StatusCode,
    response::{
        Sse,
        sse::{Event as SseAxumEvent, KeepAlive},
    },
    routing::{get, post},
};
use futures_util::stream;
use serde::Deserialize;
use tokio::sync::{broadcast, mpsc, oneshot};

use crate::events::{EventHub, GlobalEvent};
use crate::markdown::{escape_html, render_markdown, render_plain};
use crate::runtime::{AttachedAgent, LiveStatus, RuntimeError, SelectedRuntime};

/// SSE event names on the chat stream.
pub const EVT_INIT: &str = "init";
pub const EVT_ENTRY: &str = "entry";
pub const EVT_DELTA: &str = "delta";
pub const EVT_STATUS: &str = "status";
pub const EVT_NOTICE: &str = "notice";

/// Coalescing window for streaming deltas (ADR 0003: ~50–100ms).
const DELTA_FLUSH_MS: u64 = 75;
/// SSE keepalive: Cloudflare idles at ~100s, so ping well inside it.
const KEEPALIVE_SECS: u64 = 20;
/// pi command round-trips (the old client waited 15s).
const CMD_TIMEOUT: Duration = Duration::from_secs(15);
/// Internal requests (attach-time `get_state`, reconciles).
const INTERNAL_TIMEOUT: Duration = Duration::from_secs(10);
/// Ring buffer cap for the stderr/diagnostics log (old: 200 lines).
const LOG_CAP: usize = 200;
/// Spontaneously-exited bridges linger this long for UIs, then prune.
pub const EXIT_PRUNE_AFTER: Duration = Duration::from_secs(60);

fn status_str(status: LiveStatus) -> &'static str {
    match status {
        LiveStatus::Idle => "idle",
        LiveStatus::Streaming => "streaming",
        LiveStatus::Exited => "exited",
    }
}

/// Errors from bridge command paths.
#[derive(Debug, thiserror::Error)]
pub enum BridgeError {
    #[error("agent is not attached (exited?)")]
    Exited,
    #[error("bridge is destroyed")]
    Destroyed,
    #[error("pi request timed out: {0}")]
    Timeout(String),
    #[error("pi error: {0}")]
    Pi(String),
    #[error("transport: {0}")]
    Transport(String),
}

impl From<RuntimeError> for BridgeError {
    fn from(err: RuntimeError) -> Self {
        BridgeError::Transport(err.to_string())
    }
}

/// One chat-stream SSE event: named event + JSON `data` line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
}

impl SseEvent {
    fn new(event: &str, data: serde_json::Value) -> Self {
        Self {
            event: event.to_string(),
            data: data.to_string(),
        }
    }
}

impl From<SseEvent> for SseAxumEvent {
    fn from(ev: SseEvent) -> Self {
        SseAxumEvent::default().event(ev.event).data(ev.data)
    }
}

/// Cached pi state (port of the old bridge's `state` + `readOnly`).
#[derive(Clone, Debug, Default)]
pub struct CachedState {
    pub model: Option<PiModel>,
    pub thinking_level: Option<String>,
    pub session_name: Option<String>,
    pub session_file: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PiModel {
    pub provider: String,
    pub id: String,
    pub name: Option<String>,
}

/// One committed chat entry with its rendered fragment.
#[derive(Clone, Debug)]
pub struct StoredEntry {
    pub id: String,
    pub kind: EntryKind,
    pub html: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryKind {
    User,
    Assistant,
    ToolResult,
    Compaction,
}

impl EntryKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            EntryKind::User => "user",
            EntryKind::Assistant => "assistant",
            EntryKind::ToolResult => "toolresult",
            EntryKind::Compaction => "compaction",
        }
    }
}

/// In-flight tool card inside the streaming draft.
#[derive(Clone, Debug)]
struct ToolDraft {
    id: String,
    name: String,
    args_text: String,
    running: bool,
    output: Option<String>,
    result: Option<(String, bool)>,
}

/// In-flight assistant turn: accumulates `message_update` deltas until the
/// turn commits (reconcile) or aborts (freeze as a stopped entry).
#[derive(Debug, Default)]
struct StreamingDraft {
    active: bool,
    model: Option<String>,
    text: String,
    thinking: Vec<String>,
    tools: Vec<ToolDraft>,
    dirty: bool,
}

/// Notify texts announcing a read-only mode change (the dashboard read-only
/// extension emits these on `/read-only on|off` and at session start).
/// Port of `READ_ONLY_RE` — hand-rolled, no regex crate for one check.
pub fn parse_read_only(text: &str) -> Option<bool> {
    let lower = text.to_lowercase();
    let idx = lower.find("read-only mode")?;
    let mut rest = lower[idx + "read-only mode".len()..].trim_start();
    if let Some(stripped) = rest.strip_prefix("is") {
        rest = stripped.trim_start();
    }
    for (word, value) in [("on", true), ("off", false)] {
        if let Some(after) = rest.strip_prefix(word)
            && after
                .chars()
                .next()
                .is_none_or(|c| !c.is_ascii_alphabetic())
        {
            return Some(value);
        }
    }
    None
}

/// Join the `text` blocks of a pi message content (port of `blocksToText`).
fn blocks_to_text(content: &serde_json::Value) -> String {
    match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| {
                if b.get("type").and_then(|v| v.as_str()) == Some("text") {
                    b.get("text").and_then(|v| v.as_str())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => String::new(),
    }
}

/// Extract a tool result's text (port of `resultText`).
fn result_text(content: &serde_json::Value) -> String {
    blocks_to_text(content)
}

fn pretty_args(args: &serde_json::Value) -> String {
    match args {
        serde_json::Value::String(s) => s.clone(),
        _ => serde_json::to_string_pretty(args).unwrap_or_else(|_| args.to_string()),
    }
}

/// Split an assistant message into text / thinking / tool parts
/// (port of `contentToBlocks`).
fn content_parts(msg: &serde_json::Value) -> (Vec<String>, Vec<String>, Vec<ToolDraft>) {
    let Some(content) = msg.get("content") else {
        return (Vec::new(), Vec::new(), Vec::new());
    };
    if let Some(s) = content.as_str() {
        if s.is_empty() {
            return (Vec::new(), Vec::new(), Vec::new());
        }
        return (vec![s.to_string()], Vec::new(), Vec::new());
    }
    let mut texts = Vec::new();
    let mut thinking = Vec::new();
    let mut tools = Vec::new();
    for block in content.as_array().cloned().unwrap_or_default() {
        match block.get("type").and_then(|v| v.as_str()) {
            Some("text") => {
                if let Some(t) = block.get("text").and_then(|v| v.as_str())
                    && !t.is_empty()
                {
                    texts.push(t.to_string());
                }
            }
            Some("thinking") => {
                if let Some(t) = block.get("thinking").and_then(|v| v.as_str()) {
                    thinking.push(t.to_string());
                }
            }
            Some("toolCall") => tools.push(ToolDraft {
                id: block
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                name: block
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("tool")
                    .to_string(),
                args_text: block.get("arguments").map(pretty_args).unwrap_or_default(),
                running: false,
                output: None,
                result: None,
            }),
            _ => {}
        }
    }
    (texts, thinking, tools)
}

/// DOM-safe id for entry fragments: pi ids are already tame (`e1`,
/// `hist-c1`), but temp ids pass through here too.
fn dom_id(raw: &str) -> String {
    let clean: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ':' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if clean.is_empty() {
        "entry".to_string()
    } else {
        clean
    }
}

fn truncate(s: &str, n: usize) -> String {
    let flat: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > n {
        format!(
            "{}…",
            flat.chars().take(n.saturating_sub(1)).collect::<String>()
        )
    } else {
        flat
    }
}

/// Summary-line hint: the bash command, like the old tool card.
fn summary_arg(name: &str, args_text: &str) -> String {
    if name != "bash" || args_text.trim().is_empty() {
        return String::new();
    }
    let command = match serde_json::from_str::<serde_json::Value>(args_text) {
        Ok(v) => v
            .get("command")
            .and_then(|c| c.as_str())
            .unwrap_or(args_text)
            .to_string(),
        Err(_) => args_text.to_string(),
    };
    let flat: String = command.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > 80 {
        format!("{}…", flat.chars().take(79).collect::<String>())
    } else {
        flat
    }
}

fn tool_card_html(tool: &ToolDraft) -> String {
    let status = if tool.running {
        "…"
    } else if let Some((_, is_error)) = &tool.result {
        if *is_error { "✗" } else { "✓" }
    } else {
        ""
    };
    let mut out = String::new();
    let err_class = if tool.result.as_ref().is_some_and(|(_, e)| *e) {
        " error"
    } else {
        ""
    };
    out.push_str(&format!(
        "<details class=\"tool-card{err_class}\"><summary><span class=\"tool-status\">{}</span> <span class=\"tool-name\">{}</span>",
        escape_html(status),
        escape_html(&tool.name),
    ));
    let brief = summary_arg(&tool.name, &tool.args_text);
    if !brief.is_empty() {
        out.push_str(&format!(
            " <code class=\"tool-brief\">{}</code>",
            escape_html(&brief)
        ));
    }
    out.push_str("</summary><div class=\"tool-body\">");
    if !tool.args_text.is_empty() {
        out.push_str(&format!(
            "<div class=\"tool-label\">input</div><pre>{}</pre>",
            escape_html(&tool.args_text)
        ));
    }
    if let Some(output) = &tool.output
        && !output.is_empty()
    {
        out.push_str(&format!(
            "<div class=\"tool-label\">output (partial)</div><pre>{}</pre>",
            escape_html(output)
        ));
    }
    if let Some((text, _)) = &tool.result {
        out.push_str(&format!(
            "<div class=\"tool-label\">result</div><pre>{}</pre>",
            escape_html(if text.is_empty() { "(no output)" } else { text })
        ));
    }
    out.push_str("</div></details>");
    out
}

fn assistant_body_html(
    texts: &[String],
    thinking: &[String],
    tools: &[ToolDraft],
    stopped: bool,
    live: bool,
) -> String {
    let mut out = String::new();
    for t in thinking {
        out.push_str(&format!(
            "<details class=\"thinking\"><summary>thinking</summary><div class=\"thinking-body\">{}</div></details>",
            escape_html(t)
        ));
    }
    for tool in tools {
        out.push_str(&tool_card_html(tool));
    }
    for t in texts {
        out.push_str(&format!("<div class=\"md\">{}</div>", render_markdown(t)));
    }
    if stopped {
        out.push_str(
            "<div class=\"stopped dim\" title=\"The turn was stopped before it finished\">stopped — reply truncated</div>",
        );
    }
    if live {
        out.push_str("<span class=\"cursor\" aria-hidden=\"true\"></span>");
    }
    out
}

fn render_user_entry(id: &str, text: &str) -> StoredEntry {
    StoredEntry {
        id: id.to_string(),
        kind: EntryKind::User,
        html: format!(
            "<div class=\"msg user\" id=\"entry-{}\"><div class=\"bubble\">{}</div></div>",
            dom_id(id),
            render_plain(text)
        ),
    }
}

fn render_assistant_entry(
    id: &str,
    texts: &[String],
    thinking: &[String],
    tools: &[ToolDraft],
    stopped: bool,
) -> StoredEntry {
    StoredEntry {
        id: id.to_string(),
        kind: EntryKind::Assistant,
        html: format!(
            "<div class=\"msg assistant\" id=\"entry-{}\">{}</div>",
            dom_id(id),
            assistant_body_html(texts, thinking, tools, stopped, false)
        ),
    }
}

fn render_toolresult_entry(id: &str, tool_name: &str, text: &str, is_error: bool) -> StoredEntry {
    let tool = ToolDraft {
        id: id.to_string(),
        name: tool_name.to_string(),
        args_text: String::new(),
        running: false,
        output: None,
        result: Some((text.to_string(), is_error)),
    };
    StoredEntry {
        id: id.to_string(),
        kind: EntryKind::ToolResult,
        html: format!(
            "<div class=\"msg assistant\" id=\"entry-{}\">{}</div>",
            dom_id(id),
            tool_card_html(&tool)
        ),
    }
}

fn render_compaction_entry(id: &str, summary: &str) -> StoredEntry {
    StoredEntry {
        id: id.to_string(),
        kind: EntryKind::Compaction,
        html: format!(
            "<div class=\"compaction\" id=\"entry-{}\"><details><summary>context compacted</summary><p class=\"dim\">{}</p></details></div>",
            dom_id(id),
            escape_html(summary)
        ),
    }
}

/// Render one committed pi entry (port of `entryToItems` + `MessageView`).
/// Returns `None` for shapes with nothing to show (empty user text, etc.).
fn render_committed(entry: &serde_json::Value) -> Option<StoredEntry> {
    let id = entry.get("id").and_then(|v| v.as_str())?;
    match entry.get("type").and_then(|v| v.as_str()) {
        Some("message") => {
            let msg = entry.get("message")?;
            match msg.get("role").and_then(|v| v.as_str()) {
                Some("user") => {
                    let text = msg.get("content").map(blocks_to_text).unwrap_or_default();
                    let text = text.trim();
                    if text.is_empty() {
                        return None;
                    }
                    Some(render_user_entry(id, text))
                }
                Some("assistant") => {
                    let (texts, thinking, tools) = content_parts(msg);
                    if texts.is_empty() && thinking.is_empty() && tools.is_empty() {
                        return None;
                    }
                    Some(render_assistant_entry(id, &texts, &thinking, &tools, false))
                }
                Some("toolResult") => {
                    let text = msg.get("content").map(result_text).unwrap_or_default();
                    let name = msg
                        .get("toolName")
                        .and_then(|v| v.as_str())
                        .unwrap_or("tool");
                    Some(render_toolresult_entry(
                        id,
                        name,
                        &text,
                        msg.get("isError")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false),
                    ))
                }
                _ => None,
            }
        }
        Some("compaction") => {
            let summary = entry.get("summary").and_then(|v| v.as_str()).unwrap_or("");
            Some(render_compaction_entry(id, summary))
        }
        _ => None,
    }
}

/// A bridge owns one agent's pi attachment and fans chat out to SSE viewers.
///
/// Never stops the agent on disconnect: dropping viewers only flips the
/// idle clock the GC reaper reads.
pub struct Bridge {
    id: String,
    project: String,
    stdin: Mutex<Option<mpsc::UnboundedSender<String>>>,
    status: RwLock<LiveStatus>,
    exited_at: RwLock<Option<Instant>>,
    state: RwLock<CachedState>,
    read_only: RwLock<Option<bool>>,
    explicit_name: RwLock<Option<String>>,
    entries: RwLock<Vec<StoredEntry>>,
    entry_ids: Mutex<HashSet<String>>,
    leaf: RwLock<Option<String>>,
    /// Live user echoes awaiting their committed `get_entries` row
    /// (FIFO text match — the commit carries the stable pi id).
    pending_user: Mutex<Vec<String>>,
    streaming: Mutex<StreamingDraft>,
    sse_tx: broadcast::Sender<SseEvent>,
    hub: EventHub,
    logs: Mutex<VecDeque<String>>,
    pending: Mutex<HashMap<String, (oneshot::Sender<serde_json::Value>, serde_json::Value)>>,
    seq: AtomicU64,
    viewers: AtomicUsize,
    idle_since: RwLock<Instant>,
    destroyed: AtomicBool,
}

impl Bridge {
    /// Attach to an agent's pi process and seed state + history.
    /// `explicit_name` pins the spawn `-n` name over pi's auto-titling.
    pub fn create(
        id: &str,
        project: &str,
        attached: AttachedAgent,
        hub: EventHub,
        explicit_name: Option<String>,
    ) -> Arc<Self> {
        let (sse_tx, _) = broadcast::channel(256);
        let AttachedAgent {
            stdin_tx,
            stdout_rx,
            stderr_rx,
        } = attached;
        let bridge = Arc::new(Self {
            id: id.to_string(),
            project: project.to_string(),
            stdin: Mutex::new(Some(stdin_tx)),
            status: RwLock::new(LiveStatus::Idle),
            exited_at: RwLock::new(None),
            state: RwLock::new(CachedState::default()),
            read_only: RwLock::new(None),
            explicit_name: RwLock::new(explicit_name),
            entries: RwLock::new(Vec::new()),
            entry_ids: Mutex::new(HashSet::new()),
            leaf: RwLock::new(None),
            pending_user: Mutex::new(Vec::new()),
            streaming: Mutex::new(StreamingDraft::default()),
            sse_tx,
            hub,
            logs: Mutex::new(VecDeque::new()),
            pending: Mutex::new(HashMap::new()),
            seq: AtomicU64::new(0),
            viewers: AtomicUsize::new(0),
            idle_since: RwLock::new(Instant::now()),
            destroyed: AtomicBool::new(false),
        });
        let this = Arc::clone(&bridge);
        tokio::spawn(async move {
            this.pump_stdout(stdout_rx).await;
        });
        let this = Arc::clone(&bridge);
        tokio::spawn(async move {
            this.pump_stderr(stderr_rx).await;
        });
        bridge.seed();
        bridge.start_flusher();
        bridge
    }

    /// Best-effort snapshot for the agent list + chat header.
    fn seed(self: &Arc<Self>) {
        let this = Arc::clone(self);
        tokio::spawn(async move {
            match this
                .internal_request("get_state", serde_json::json!({}))
                .await
            {
                Ok(resp) => {
                    if resp.get("success").and_then(|v| v.as_bool()) == Some(true)
                        && let Some(data) = resp.get("data")
                    {
                        this.apply_state(data);
                    }
                }
                Err(err) => {
                    this.push_log(format!("[get_state] {err}"));
                }
            }
        });
        let this = Arc::clone(self);
        tokio::spawn(async move {
            this.reconcile(None).await;
        });
    }

    fn start_flusher(self: &Arc<Self>) {
        let this = Arc::clone(self);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(DELTA_FLUSH_MS));
            loop {
                interval.tick().await;
                if this.is_destroyed() {
                    return;
                }
                let exited = this.status() == LiveStatus::Exited;
                this.flush_delta();
                if exited {
                    return;
                }
            }
        });
    }

    // ---- identity / status -------------------------------------------------

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn project(&self) -> &str {
        &self.project
    }

    pub fn status(&self) -> LiveStatus {
        *self.status.read().unwrap()
    }

    pub fn exited_at(&self) -> Option<Instant> {
        *self.exited_at.read().unwrap()
    }

    fn set_status(&self, status: LiveStatus) {
        {
            let mut guard = self.status.write().unwrap();
            if *guard == status {
                return;
            }
            *guard = status;
            if status == LiveStatus::Exited {
                *self.exited_at.write().unwrap() = Some(Instant::now());
            }
        }
        self.broadcast(SseEvent::new(
            EVT_STATUS,
            serde_json::json!({ "status": status_str(status) }),
        ));
        self.hub.publish(GlobalEvent::AgentStatus {
            id: self.id.clone(),
            project: self.project.clone(),
            status: status_str(status).to_string(),
        });
    }

    /// Dashboard-initiated teardown (the terminate path): tell every open
    /// chat first, then drop the attachment. Idempotent.
    pub fn destroy(&self) {
        if self.destroyed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.broadcast(SseEvent::new(
            EVT_STATUS,
            serde_json::json!({ "status": "exited" }),
        ));
        self.hub.publish(GlobalEvent::AgentStatus {
            id: self.id.clone(),
            project: self.project.clone(),
            status: "exited".to_string(),
        });
        // Fail every in-flight command: dropping the senders trips the
        // receivers with a closed-channel error the handlers map to Gone.
        self.pending.lock().unwrap().clear();
        // Dropping the sender closes pi stdin, like the old socket destroy.
        self.stdin.lock().unwrap().take();
    }

    pub fn is_destroyed(&self) -> bool {
        self.destroyed.load(Ordering::SeqCst)
    }

    /// The pi process went away on its own: freeze any half-streamed turn
    /// as its final content, render the exit, keep the bridge cached
    /// briefly so UIs can show it. (No reconcile here: the transport is
    /// gone, so no response could arrive — the pump below is finished.)
    fn mark_exited(&self) {
        if self.is_destroyed() {
            return;
        }
        self.freeze_draft();
        self.set_status(LiveStatus::Exited);
    }

    /// Freeze an active draft with content as a stopped entry (abort/exit
    /// path). No-op when the draft is empty or already retired.
    fn freeze_draft(&self) {
        let frozen = {
            let mut draft = self.streaming.lock().unwrap();
            if !draft.active
                || (draft.text.is_empty() && draft.thinking.is_empty() && draft.tools.is_empty())
            {
                return;
            }
            let frozen = (
                draft.text.clone(),
                draft.thinking.clone(),
                draft.tools.clone(),
            );
            draft.active = false;
            draft.dirty = false;
            frozen
        };
        let (text, thinking, tools) = frozen;
        let id = self.next_id("live");
        let stored = render_assistant_entry(&id, &[text], &thinking, &tools, true);
        self.entry_ids.lock().unwrap().insert(id);
        self.entries.write().unwrap().push(stored.clone());
        self.broadcast(SseEvent::new(
            EVT_ENTRY,
            serde_json::json!({ "id": stored.id, "kind": "assistant", "html": stored.html }),
        ));
        self.broadcast(SseEvent::new(EVT_DELTA, serde_json::json!({ "html": "" })));
    }

    // ---- viewers (never-stop-on-disconnect) --------------------------------

    /// Open a viewer session: increments the count; dropping the guard
    /// decrements and restarts the GC idle clock.
    pub fn viewing(self: &Arc<Self>) -> ViewerGuard {
        self.viewers.fetch_add(1, Ordering::SeqCst);
        ViewerGuard {
            bridge: Arc::clone(self),
        }
    }

    fn viewer_left(&self) {
        if self.viewers.fetch_sub(1, Ordering::SeqCst) == 1 {
            *self.idle_since.write().unwrap() = Instant::now();
        }
    }

    pub fn client_count(&self) -> usize {
        self.viewers.load(Ordering::SeqCst)
    }

    /// When the bridge last became viewer-free (birth when never viewed).
    pub fn idle_since(&self) -> Instant {
        *self.idle_since.read().unwrap()
    }

    #[cfg(test)]
    pub fn set_idle_since(&self, t: Instant) {
        *self.idle_since.write().unwrap() = t;
    }

    #[cfg(test)]
    pub fn set_exited_at(&self, t: Instant) {
        *self.exited_at.write().unwrap() = Some(t);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SseEvent> {
        self.sse_tx.subscribe()
    }

    fn broadcast(&self, ev: SseEvent) {
        let _ = self.sse_tx.send(ev);
    }

    // ---- cached state -------------------------------------------------------

    /// Merge a partial `get_state`-shaped object into the cache.
    fn apply_state(&self, data: &serde_json::Value) {
        {
            let mut state = self.state.write().unwrap();
            if let Some(model) = data.get("model") {
                state.model = if model.is_null() {
                    None
                } else {
                    match (
                        model.get("provider").and_then(|v| v.as_str()),
                        model.get("id").and_then(|v| v.as_str()),
                    ) {
                        (Some(provider), Some(id)) => Some(PiModel {
                            provider: provider.to_string(),
                            id: id.to_string(),
                            name: model
                                .get("name")
                                .and_then(|v| v.as_str())
                                .map(str::to_string),
                        }),
                        _ => None,
                    }
                };
            }
            if let Some(level) = data.get("thinkingLevel") {
                state.thinking_level = level.as_str().map(str::to_string);
            }
            if let Some(name) = data.get("sessionName") {
                state.session_name = name.as_str().map(str::to_string);
            }
            if let Some(file) = data.get("sessionFile") {
                state.session_file = file.as_str().map(str::to_string);
            }
        }
        // A spawn `-n` name sticks: pi's auto-titling never overrides it.
        if let Some(explicit) = self.explicit_name.read().unwrap().clone() {
            self.state.write().unwrap().session_name = Some(explicit);
        }
    }

    /// After a successful state-mutating command: refresh the cache and fan
    /// a notice out so every tab of the chat stays in sync.
    fn observe_response(&self, resp: &serde_json::Value, command: &serde_json::Value) {
        if resp.get("success").and_then(|v| v.as_bool()) != Some(true) {
            return;
        }
        match resp.get("command").and_then(|v| v.as_str()).unwrap_or("") {
            "get_state" => {
                if let Some(data) = resp.get("data") {
                    self.apply_state(data);
                }
            }
            "set_model" => {
                if let Some(data) = resp.get("data") {
                    self.apply_state(&serde_json::json!({ "model": data }));
                }
                if let Some(model) = self.state.read().unwrap().model.clone() {
                    self.broadcast_notice(
                        Some(format!("model → {}/{}", model.provider, model.id)),
                        "info",
                        Some("model"),
                        Some(serde_json::json!({ "model": {
                            "provider": model.provider, "id": model.id, "name": model.name,
                        } })),
                    );
                }
            }
            "set_thinking_level" => {
                let Some(level) = command.get("level").and_then(|v| v.as_str()) else {
                    return;
                };
                self.apply_state(&serde_json::json!({ "thinkingLevel": level }));
                self.broadcast_notice(
                    Some(format!("thinking → {level}")),
                    "info",
                    Some("thinking"),
                    Some(serde_json::json!({ "thinkingLevel": level })),
                );
            }
            "set_session_name" => {
                let Some(name) = command.get("name").and_then(|v| v.as_str()) else {
                    return;
                };
                self.apply_state(&serde_json::json!({ "sessionName": name }));
                // Silent state patch (no toast — first-message titling fires
                // this on every new chat) + a list resync, like before.
                let effective = self.state.read().unwrap().session_name.clone();
                self.broadcast_notice(
                    None,
                    "info",
                    Some("session"),
                    Some(serde_json::json!({ "sessionName": effective })),
                );
                self.hub.publish(GlobalEvent::AgentsChanged {
                    action: "rename".to_string(),
                    id: self.id.clone(),
                });
            }
            _ => {}
        }
    }

    // ---- pi RPC framing -----------------------------------------------------

    fn next_id(&self, prefix: &str) -> String {
        let n = self.seq.fetch_add(1, Ordering::SeqCst);
        format!("{prefix}{n}")
    }

    fn write_to_pi(&self, obj: &serde_json::Value) -> Result<(), BridgeError> {
        let guard = self.stdin.lock().unwrap();
        match guard.as_ref() {
            Some(tx) => tx
                .send(obj.to_string())
                .map_err(|_| BridgeError::Transport("pi stdin is closed".to_string())),
            None => Err(BridgeError::Exited),
        }
    }

    /// Send one command and await its response.
    async fn request(
        &self,
        command_type: &str,
        mut body: serde_json::Value,
        prefix: &str,
        timeout: Duration,
    ) -> Result<serde_json::Value, BridgeError> {
        if self.is_destroyed() || self.status() == LiveStatus::Exited {
            return Err(BridgeError::Exited);
        }
        let id = self.next_id(prefix);
        if let Some(obj) = body.as_object_mut() {
            obj.insert(
                "type".to_string(),
                serde_json::Value::String(command_type.to_string()),
            );
            obj.insert("id".to_string(), serde_json::Value::String(id.clone()));
        }
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap()
            .insert(id.clone(), (tx, body.clone()));
        if let Err(err) = self.write_to_pi(&body) {
            self.pending.lock().unwrap().remove(&id);
            return Err(err);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(resp)) => {
                if resp.get("success").and_then(|v| v.as_bool()) == Some(false) {
                    let msg = resp
                        .get("error")
                        .and_then(|v| v.as_str())
                        .unwrap_or("pi command failed");
                    let cmd = resp
                        .get("command")
                        .and_then(|v| v.as_str())
                        .unwrap_or(command_type);
                    return Err(BridgeError::Pi(format!("{cmd}: {msg}")));
                }
                Ok(resp)
            }
            Ok(Err(_)) => Err(BridgeError::Destroyed),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(BridgeError::Timeout(command_type.to_string()))
            }
        }
    }

    async fn internal_request(
        &self,
        command_type: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, BridgeError> {
        self.request(command_type, body, "i", INTERNAL_TIMEOUT)
            .await
    }

    /// Reconcile committed entries: `get_entries` since the cursor, render
    /// anything new, broadcast `entry` events. The settle-time reconcile is
    /// the reliable catch-all; mid-turn ones are best-effort.
    async fn reconcile(&self, since: Option<String>) {
        if self.is_destroyed() {
            return;
        }
        let cursor = since.or_else(|| self.leaf.read().unwrap().clone());
        let mut body = serde_json::json!({});
        if let Some(since) = &cursor
            && let Some(obj) = body.as_object_mut()
        {
            obj.insert(
                "since".to_string(),
                serde_json::Value::String(since.clone()),
            );
        }
        let resp = match self.internal_request("get_entries", body).await {
            Ok(resp) => resp,
            Err(err) => {
                self.push_log(format!("[get_entries] {err}"));
                return;
            }
        };
        if resp.get("success").and_then(|v| v.as_bool()) != Some(true) {
            // Unknown cursor (or any failure): a full refetch converges via
            // the id set, so a stale cursor never loses content.
            if cursor.is_some() {
                self.reconcile_full().await;
            }
            return;
        }
        let entries = resp
            .get("data")
            .and_then(|d| d.get("entries"))
            .and_then(|e| e.as_array())
            .cloned()
            .unwrap_or_default();
        let leaf_id = resp
            .get("data")
            .and_then(|d| d.get("leafId"))
            .and_then(|v| v.as_str())
            .map(str::to_string);
        self.merge_entries(entries, leaf_id);
    }

    async fn reconcile_full(&self) {
        let resp = match self
            .internal_request("get_entries", serde_json::json!({}))
            .await
        {
            Ok(resp) => resp,
            Err(err) => {
                self.push_log(format!("[get_entries full] {err}"));
                return;
            }
        };
        if resp.get("success").and_then(|v| v.as_bool()) != Some(true) {
            return;
        }
        let entries = resp
            .get("data")
            .and_then(|d| d.get("entries"))
            .and_then(|e| e.as_array())
            .cloned()
            .unwrap_or_default();
        let leaf_id = resp
            .get("data")
            .and_then(|d| d.get("leafId"))
            .and_then(|v| v.as_str())
            .map(str::to_string);
        self.merge_entries(entries, leaf_id);
    }

    /// Merge fetched entries into the log, broadcasting new ones. Live user
    /// echoes claim their commit by text (FIFO) so the optimistic row is not
    /// duplicated when its stable pi id lands.
    fn merge_entries(&self, entries: Vec<serde_json::Value>, leaf_id: Option<String>) {
        let mut fresh: Vec<StoredEntry> = Vec::new();
        {
            // Lock order (global): entry_ids → pending_user → entries.
            let mut ids = self.entry_ids.lock().unwrap();
            let mut pending_user = self.pending_user.lock().unwrap();
            let mut log = self.entries.write().unwrap();
            for entry in &entries {
                let Some(id) = entry.get("id").and_then(|v| v.as_str()) else {
                    continue;
                };
                if ids.contains(id) {
                    continue;
                }
                ids.insert(id.to_string());
                if is_user_message(entry) {
                    let text = entry
                        .get("message")
                        .and_then(|m| m.get("content"))
                        .map(blocks_to_text)
                        .unwrap_or_default();
                    let text = text.trim().to_string();
                    if let Some(pos) = pending_user.iter().position(|t| *t == text) {
                        pending_user.remove(pos);
                        continue;
                    }
                }
                if let Some(stored) = render_committed(entry) {
                    log.push(stored.clone());
                    fresh.push(stored);
                }
            }
        }
        if let Some(leaf) = leaf_id {
            *self.leaf.write().unwrap() = Some(leaf);
        }
        for stored in &fresh {
            self.broadcast(SseEvent::new(
                EVT_ENTRY,
                serde_json::json!({ "id": stored.id, "kind": stored.kind.as_str(), "html": stored.html }),
            ));
        }
        self.maybe_close_draft(fresh.iter().any(|e| e.kind == EntryKind::Assistant));
    }

    /// After new committed rows: when the turn's assistant row has landed,
    /// retire the streaming overlay (flushing any coalesced text first,
    /// then clearing the bubble via an empty delta). Abort path: the turn
    /// settled with the draft still holding the streamed prefix and no
    /// committed row — freeze it as the final content (port of the old
    /// client's stopped-bubble rule).
    fn maybe_close_draft(&self, assistant_landed: bool) {
        struct Retirement {
            pending_html: Option<String>,
            freeze: Option<(String, Vec<String>, Vec<ToolDraft>)>,
        }
        let retirement = {
            let mut draft = self.streaming.lock().unwrap();
            if !draft.active {
                return;
            }
            let settled = matches!(self.status(), LiveStatus::Idle | LiveStatus::Exited);
            if !(assistant_landed || settled) {
                return;
            }
            let pending_html = if draft.dirty {
                let texts: Vec<String> = if draft.text.is_empty() {
                    Vec::new()
                } else {
                    vec![draft.text.clone()]
                };
                Some(assistant_body_html(
                    &texts,
                    &draft.thinking,
                    &draft.tools,
                    false,
                    true,
                ))
            } else {
                None
            };
            // Freeze only when the turn settled with no committed row
            // (abort) and the draft actually holds content; a landed row
            // is the record, the draft is redundant.
            let freeze = if !assistant_landed
                && settled
                && (!draft.text.is_empty() || !draft.thinking.is_empty() || !draft.tools.is_empty())
            {
                Some((
                    draft.text.clone(),
                    draft.thinking.clone(),
                    draft.tools.clone(),
                ))
            } else {
                None
            };
            draft.active = false;
            draft.dirty = false;
            Retirement {
                pending_html,
                freeze,
            }
        };
        if let Some(html) = retirement.pending_html {
            self.broadcast(SseEvent::new(
                EVT_DELTA,
                serde_json::json!({ "html": html }),
            ));
        }
        self.broadcast(SseEvent::new(EVT_DELTA, serde_json::json!({ "html": "" })));
        if let Some((text, thinking, tools)) = retirement.freeze {
            let id = self.next_id("live");
            let stored = render_assistant_entry(&id, &[text], &thinking, &tools, true);
            self.entry_ids.lock().unwrap().insert(id);
            self.entries.write().unwrap().push(stored.clone());
            self.broadcast(SseEvent::new(
                EVT_ENTRY,
                serde_json::json!({ "id": stored.id, "kind": "assistant", "html": stored.html }),
            ));
        }
    }

    // ---- stdout / RPC pump --------------------------------------------------
    // NOTE: reconciles never run inline here: the pump is the only task
    // routing pi responses, so awaiting one would deadlock. They spawn as
    // background tasks (the settle reconcile is the reliable catch-all).

    async fn pump_stdout(self: Arc<Self>, mut rx: mpsc::UnboundedReceiver<String>) {
        while let Some(line) = rx.recv().await {
            if self.is_destroyed() {
                break;
            }
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<serde_json::Value>(&line) {
                Ok(obj) => self.handle_line(obj).await,
                Err(_) => {
                    self.push_log(format!(
                        "[unparseable stdout line] {}",
                        truncate(&line, 200)
                    ));
                }
            }
        }
        self.mark_exited();
    }

    async fn pump_stderr(&self, mut rx: mpsc::UnboundedReceiver<String>) {
        while let Some(line) = rx.recv().await {
            if self.is_destroyed() {
                break;
            }
            self.push_log(line);
        }
    }

    async fn handle_line(self: &Arc<Self>, obj: serde_json::Value) {
        let kind = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match kind {
            "response" => self.handle_response(obj),
            "extension_ui_request" => self.handle_extension_ui(obj),
            "agent_start" => self.set_status(LiveStatus::Streaming),
            "agent_settled" => {
                self.set_status(LiveStatus::Idle);
                self.spawn_reconcile();
            }
            "message_start" => self.handle_message_start(&obj),
            "message_update" => self.handle_message_update(&obj),
            "message_end" => {
                // Best-effort mid-turn reconcile; the settle reconcile
                // converges even when the commit races this event.
                self.spawn_reconcile();
            }
            "tool_execution_start" | "tool_execution_update" | "tool_execution_end" => {
                self.handle_tool_execution(kind, &obj);
            }
            "extension_error" => {
                let text = format!(
                    "extension error: {}",
                    obj.get("error")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown")
                );
                self.broadcast_notice(Some(text), "error", None, None);
            }
            "auto_retry_start" => {
                let text = format!(
                    "retrying (attempt {}): {}",
                    obj.get("attempt").and_then(|v| v.as_i64()).unwrap_or(0),
                    obj.get("errorMessage")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                );
                self.broadcast_notice(Some(text), "warning", None, None);
            }
            _ => {}
        }
    }

    /// Reconcile off-task (see the pump note above): the response can only
    /// be routed by the pump, so awaiting it inline would deadlock.
    fn spawn_reconcile(self: &Arc<Self>) {
        let this = Arc::clone(self);
        tokio::spawn(async move {
            this.reconcile(None).await;
        });
    }

    fn handle_response(&self, obj: serde_json::Value) {
        let route = obj
            .get("id")
            .and_then(|v| v.as_str())
            .and_then(|id| self.pending.lock().unwrap().remove(id));
        match route {
            Some((waiter, command)) => {
                let _ = waiter.send(obj.clone());
                self.observe_response(&obj, &command);
            }
            None => {
                if obj.get("success").and_then(|v| v.as_bool()) == Some(false) {
                    self.push_log(format!("[rpc error] {}", truncate(&obj.to_string(), 300)));
                }
            }
        }
    }

    fn handle_extension_ui(&self, obj: serde_json::Value) {
        let method = obj.get("method").and_then(|v| v.as_str()).unwrap_or("");
        if method == "notify" {
            let message = obj.get("message").and_then(|v| v.as_str()).unwrap_or("");
            let level = obj
                .get("notifyType")
                .and_then(|v| v.as_str())
                .unwrap_or("info");
            if let Some(on) = parse_read_only(message) {
                *self.read_only.write().unwrap() = Some(on);
                self.broadcast_notice(
                    Some(message.to_string()),
                    level,
                    Some("read-only"),
                    Some(serde_json::json!({ "readOnly": on })),
                );
            } else {
                self.broadcast_notice(Some(message.to_string()), level, None, None);
            }
            return;
        }
        // Blocking dialog with nothing headless to answer it: drop, loudly.
        if matches!(method, "select" | "confirm" | "input" | "editor") {
            self.broadcast_notice(
                Some(format!(
                    "Dialog request '{method}' was dropped (the dashboard has no headless UI for it)"
                )),
                "warning",
                Some("dialog"),
                None,
            );
        }
    }

    fn handle_message_start(&self, obj: &serde_json::Value) {
        let Some(msg) = obj.get("message") else {
            return;
        };
        match msg.get("role").and_then(|v| v.as_str()) {
            Some("user") => {
                let text = msg.get("content").map(blocks_to_text).unwrap_or_default();
                let text = text.trim().to_string();
                if text.is_empty() || text.starts_with('/') {
                    return;
                }
                // Optimistic echo, claimed by its commit at reconcile. A
                // duplicate start for the same text is ignored.
                {
                    let mut pending = self.pending_user.lock().unwrap();
                    if pending.contains(&text) {
                        return;
                    }
                    pending.push(text.clone());
                }
                let id = self.next_id("live");
                let stored = render_user_entry(&id, &text);
                self.entries.write().unwrap().push(stored.clone());
                self.broadcast(SseEvent::new(
                    EVT_ENTRY,
                    serde_json::json!({ "id": stored.id, "kind": "user", "html": stored.html }),
                ));
            }
            Some("assistant") => {
                let mut draft = self.streaming.lock().unwrap();
                draft.active = true;
                draft.text.clear();
                draft.thinking.clear();
                draft.tools.clear();
                draft.dirty = false;
                draft.model = msg
                    .get("model")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
            }
            _ => {}
        }
    }

    fn handle_message_update(&self, obj: &serde_json::Value) {
        let Some(ev) = obj.get("assistantMessageEvent") else {
            return;
        };
        let mut draft = self.streaming.lock().unwrap();
        if !draft.active {
            // Attached mid-turn: synthesize the draft on a block start so
            // deltas keep streaming instead of dropping (port of the old
            // client's mid-turn synthesis).
            let kind = ev.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if !matches!(kind, "text_start" | "thinking_start" | "toolcall_start") {
                return;
            }
            draft.active = true;
        }
        match ev.get("type").and_then(|v| v.as_str()) {
            Some("text_start") => {
                if !draft.text.is_empty() {
                    draft.text.push_str("\n\n");
                }
                draft.dirty = true;
            }
            Some("text_delta") => {
                if let Some(d) = ev.get("delta").and_then(|v| v.as_str()) {
                    draft.text.push_str(d);
                    draft.dirty = true;
                }
            }
            Some("thinking_start") => {
                draft.thinking.push(String::new());
                draft.dirty = true;
            }
            Some("thinking_delta") => {
                if let Some(d) = ev.get("delta").and_then(|v| v.as_str()) {
                    if draft.thinking.is_empty() {
                        draft.thinking.push(String::new());
                    }
                    if let Some(last) = draft.thinking.last_mut() {
                        last.push_str(d);
                    }
                    draft.dirty = true;
                }
            }
            Some("toolcall_start") => {
                let id = ev
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if !id.is_empty() && draft.tools.iter().any(|t| t.id == id) {
                    return;
                }
                let auto_id = format!("t{}", draft.tools.len());
                draft.tools.push(ToolDraft {
                    id: if id.is_empty() { auto_id } else { id },
                    name: ev
                        .get("toolName")
                        .and_then(|v| v.as_str())
                        .unwrap_or("tool")
                        .to_string(),
                    args_text: String::new(),
                    running: true,
                    output: None,
                    result: None,
                });
                draft.dirty = true;
            }
            Some("toolcall_delta") => {
                if let Some(d) = ev.get("delta").and_then(|v| v.as_str())
                    && let Some(tool) = draft.tools.last_mut()
                {
                    tool.args_text.push_str(d);
                    draft.dirty = true;
                }
            }
            Some("toolcall_end") => {
                if let Some(tool) = draft.tools.last_mut() {
                    if let Some(call) = ev.get("toolCall") {
                        tool.args_text = call.get("arguments").map(pretty_args).unwrap_or_default();
                    }
                    draft.dirty = true;
                }
            }
            _ => {}
        }
    }

    fn handle_tool_execution(&self, kind: &str, obj: &serde_json::Value) {
        let Some(tool_id) = obj.get("toolCallId").and_then(|v| v.as_str()) else {
            return;
        };
        let mut draft = self.streaming.lock().unwrap();
        let Some(tool) = draft.tools.iter_mut().find(|t| t.id == tool_id) else {
            return;
        };
        match kind {
            "tool_execution_start" => {
                tool.running = true;
                if tool.args_text.trim().is_empty()
                    && let Some(args) = obj.get("args")
                {
                    tool.args_text = pretty_args(args);
                }
                draft.dirty = true;
            }
            "tool_execution_update" => {
                tool.output = obj
                    .get("partialResult")
                    .and_then(|r| r.get("content"))
                    .map(result_text);
                draft.dirty = true;
            }
            "tool_execution_end" => {
                tool.running = false;
                tool.result = Some((
                    obj.get("result")
                        .and_then(|r| r.get("content"))
                        .map(result_text)
                        .unwrap_or_default(),
                    obj.get("isError")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                ));
                draft.dirty = true;
            }
            _ => {}
        }
    }

    /// Flush one coalesced `delta` when the draft is dirty.
    fn flush_delta(&self) {
        let html = {
            let mut draft = self.streaming.lock().unwrap();
            if !draft.active || !draft.dirty {
                return;
            }
            draft.dirty = false;
            let texts: Vec<String> = if draft.text.is_empty() {
                Vec::new()
            } else {
                vec![draft.text.clone()]
            };
            assistant_body_html(&texts, &draft.thinking, &draft.tools, false, true)
        };
        self.broadcast(SseEvent::new(
            EVT_DELTA,
            serde_json::json!({ "html": html }),
        ));
    }

    fn broadcast_notice(
        &self,
        text: Option<String>,
        level: &str,
        key: Option<&str>,
        state: Option<serde_json::Value>,
    ) {
        let level = match level {
            "error" | "warning" => level,
            _ => "info",
        };
        let mut data = serde_json::json!({ "level": level });
        if let Some(text) = text {
            data["text"] = serde_json::Value::String(text);
        }
        if let Some(key) = key {
            data["key"] = serde_json::Value::String(key.to_string());
        }
        if let Some(state) = state {
            data["state"] = state;
        }
        self.broadcast(SseEvent::new(EVT_NOTICE, data));
    }

    // ---- logs ---------------------------------------------------------------

    fn push_log(&self, line: String) {
        let mut logs = self.logs.lock().unwrap();
        logs.push_back(line);
        while logs.len() > LOG_CAP {
            logs.pop_front();
        }
    }

    pub fn log_lines(&self) -> Vec<String> {
        self.logs.lock().unwrap().iter().cloned().collect()
    }

    // ---- snapshots for SSE init ---------------------------------------------

    fn init_event(&self) -> SseEvent {
        let state = self.state.read().unwrap().clone();
        let read_only = *self.read_only.read().unwrap();
        let count = self.entries.read().unwrap().len();
        SseEvent::new(
            EVT_INIT,
            serde_json::json!({
                "status": status_str(self.status()),
                "model": state.model.map(|m| serde_json::json!({
                    "provider": m.provider, "id": m.id, "name": m.name,
                })),
                "thinkingLevel": state.thinking_level,
                "sessionName": state.session_name,
                "sessionFile": state.session_file,
                "readOnly": read_only,
                "entryCount": count,
            }),
        )
    }

    fn entry_events(&self) -> Vec<SseEvent> {
        self.entries
            .read()
            .unwrap()
            .iter()
            .map(|e| {
                SseEvent::new(
                    EVT_ENTRY,
                    serde_json::json!({ "id": e.id, "kind": e.kind.as_str(), "html": e.html }),
                )
            })
            .collect()
    }

    // ---- POST commands (plain hx-post form submissions, ADR 0003) -----------

    pub async fn prompt(&self, message: &str) -> Result<serde_json::Value, BridgeError> {
        self.request(
            "prompt",
            serde_json::json!({ "message": message }),
            "c",
            CMD_TIMEOUT,
        )
        .await
    }

    pub async fn abort(&self) -> Result<serde_json::Value, BridgeError> {
        self.request("abort", serde_json::json!({}), "c", CMD_TIMEOUT)
            .await
    }

    pub async fn set_model(
        &self,
        provider: &str,
        model_id: &str,
    ) -> Result<serde_json::Value, BridgeError> {
        self.request(
            "set_model",
            serde_json::json!({ "provider": provider, "modelId": model_id }),
            "c",
            CMD_TIMEOUT,
        )
        .await
    }

    pub async fn set_thinking_level(&self, level: &str) -> Result<serde_json::Value, BridgeError> {
        self.request(
            "set_thinking_level",
            serde_json::json!({ "level": level }),
            "c",
            CMD_TIMEOUT,
        )
        .await
    }

    pub async fn set_session_name(&self, name: &str) -> Result<serde_json::Value, BridgeError> {
        self.request(
            "set_session_name",
            serde_json::json!({ "name": name }),
            "c",
            CMD_TIMEOUT,
        )
        .await
    }

    /// Read-only toggles go through pi as an RPC `prompt` (the extension
    /// executes them immediately, even mid-turn) — same as the old UI.
    pub async fn set_read_only(&self, on: bool) -> Result<serde_json::Value, BridgeError> {
        let mode = if on { "on" } else { "off" };
        self.prompt(&format!("/read-only {mode}")).await
    }

    pub async fn session_stats(&self) -> Result<serde_json::Value, BridgeError> {
        self.request("get_session_stats", serde_json::json!({}), "c", CMD_TIMEOUT)
            .await
    }

    pub fn state_snapshot(&self) -> serde_json::Value {
        let state = self.state.read().unwrap().clone();
        let read_only = *self.read_only.read().unwrap();
        serde_json::json!({
            "status": status_str(self.status()),
            "model": state.model.map(|m| serde_json::json!({
                "provider": m.provider, "id": m.id, "name": m.name,
            })),
            "thinkingLevel": state.thinking_level,
            "sessionName": state.session_name,
            "sessionFile": state.session_file,
            "readOnly": read_only,
        })
    }
}

fn is_user_message(entry: &serde_json::Value) -> bool {
    entry.get("type").and_then(|v| v.as_str()) == Some("message")
        && entry
            .get("message")
            .and_then(|m| m.get("role"))
            .and_then(|v| v.as_str())
            == Some("user")
}

/// RAII viewer count: disconnects flip the GC clock, never stop the agent.
pub struct ViewerGuard {
    bridge: Arc<Bridge>,
}

impl Drop for ViewerGuard {
    fn drop(&mut self) {
        self.bridge.viewer_left();
    }
}

// ---- registry ---------------------------------------------------------------

/// Errors resolving an agent id to a bridge.
#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    #[error("not a pi agent: {0}")]
    NotAgent(String),
    #[error("unknown agent: {0}")]
    Unknown(String),
    #[error("attach failed: {0}")]
    Attach(String),
}

/// Bridge registry: one cached bridge per agent id, created on demand.
/// Port of the `bridges` map + `ensureBridge` in `server/bridge.ts`.
pub struct BridgeRegistry {
    inner: RwLock<HashMap<String, Arc<Bridge>>>,
    runtime: Arc<SelectedRuntime>,
    hub: EventHub,
}

impl BridgeRegistry {
    pub fn new(runtime: Arc<SelectedRuntime>, hub: EventHub) -> Self {
        Self {
            inner: RwLock::new(HashMap::new()),
            runtime,
            hub,
        }
    }

    pub fn hub(&self) -> &EventHub {
        &self.hub
    }

    pub fn get(&self, id: &str) -> Option<Arc<Bridge>> {
        self.inner.read().unwrap().get(id).cloned()
    }

    /// Return the cached bridge, attaching on first use (dashboard restarts
    /// pick running agents back up lazily, as before).
    pub async fn ensure(
        &self,
        id: &str,
        explicit_name: Option<String>,
    ) -> Result<Arc<Bridge>, RegistryError> {
        if let Some(existing) = self.get(id) {
            if explicit_name.is_some() {
                let mut pin = existing.explicit_name.write().unwrap();
                if pin.is_none() {
                    *pin = explicit_name;
                }
            }
            return Ok(existing);
        }
        let labels = self
            .runtime
            .labels(id)
            .await
            .map_err(|e| RegistryError::Attach(e.to_string()))?;
        let Some(labels) = labels else {
            return Err(RegistryError::Unknown(id.to_string()));
        };
        if labels.get("agent.kind").map(String::as_str) != Some("pi") {
            return Err(RegistryError::NotAgent(id.to_string()));
        }
        let project = labels
            .get("agent.project")
            .cloned()
            .unwrap_or_else(|| "unknown".to_string());
        let attached = self.runtime.attach(id).await.map_err(|e| match e {
            RuntimeError::UnknownAgent(_) => RegistryError::Unknown(id.to_string()),
            other => RegistryError::Attach(other.to_string()),
        })?;
        let bridge = Bridge::create(id, &project, attached, self.hub.clone(), explicit_name);
        self.inner
            .write()
            .unwrap()
            .insert(id.to_string(), Arc::clone(&bridge));
        Ok(bridge)
    }

    /// Dashboard-initiated teardown: broadcast `exited`, drop the bridge.
    pub fn destroy(&self, id: &str) {
        if let Some(bridge) = self.inner.write().unwrap().remove(id) {
            bridge.destroy();
        }
    }

    /// Terminate route: plain stop + remove, then the exited broadcast.
    /// Idempotent — stopping a gone agent succeeds.
    pub async fn terminate(&self, id: &str) -> Result<(), BridgeError> {
        self.runtime.stop_and_remove(id).await?;
        self.destroy(id);
        Ok(())
    }

    /// Drop spontaneously-exited bridges UIs have long rendered.
    pub fn prune_exited(&self, now: Instant) -> usize {
        let stale: Vec<String> = {
            let guard = self.inner.read().unwrap();
            guard
                .iter()
                .filter(|(_, bridge)| {
                    bridge.status() == LiveStatus::Exited
                        && bridge.client_count() == 0
                        && bridge
                            .exited_at()
                            .is_some_and(|t| now.duration_since(t) >= EXIT_PRUNE_AFTER)
                })
                .map(|(id, _)| id.clone())
                .collect()
        };
        let mut removed = 0;
        for id in stale {
            self.destroy(&id);
            removed += 1;
        }
        removed
    }
}

// ---- HTTP -------------------------------------------------------------------

/// Shared chat state for Axum handlers.
#[derive(Clone)]
pub struct AppState {
    pub registry: Arc<BridgeRegistry>,
}

impl AppState {
    pub fn new(registry: Arc<BridgeRegistry>) -> Self {
        Self { registry }
    }
}

#[derive(Deserialize)]
pub struct PromptForm {
    pub message: String,
}

#[derive(Deserialize)]
pub struct ModelForm {
    pub provider: String,
    #[serde(alias = "modelId")]
    pub model_id: String,
}

#[derive(Deserialize)]
pub struct ThinkingForm {
    pub level: String,
}

#[derive(Deserialize)]
pub struct SessionNameForm {
    pub name: String,
}

#[derive(Deserialize)]
pub struct ReadOnlyForm {
    pub mode: String,
}

fn bridge_err(
    status: StatusCode,
    err: impl std::fmt::Display,
) -> (StatusCode, Json<serde_json::Value>) {
    (
        status,
        Json(serde_json::json!({ "error": err.to_string() })),
    )
}

fn cmd_err(err: BridgeError) -> (StatusCode, Json<serde_json::Value>) {
    match err {
        BridgeError::Exited | BridgeError::Destroyed => bridge_err(StatusCode::GONE, err),
        BridgeError::Timeout(_) => bridge_err(StatusCode::GATEWAY_TIMEOUT, err),
        BridgeError::Pi(_) | BridgeError::Transport(_) => bridge_err(StatusCode::BAD_GATEWAY, err),
    }
}

async fn bridge_for(
    registry: &BridgeRegistry,
    id: &str,
) -> Result<Arc<Bridge>, (StatusCode, Json<serde_json::Value>)> {
    match registry.ensure(id, None).await {
        Ok(bridge) => Ok(bridge),
        Err(RegistryError::Unknown(_) | RegistryError::NotAgent(_)) => Err(bridge_err(
            StatusCode::NOT_FOUND,
            format!("unknown agent: {id}"),
        )),
        Err(err) => Err(bridge_err(StatusCode::BAD_GATEWAY, err)),
    }
}

async fn sse_stream(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<
    Sse<impl stream::Stream<Item = Result<SseAxumEvent, std::convert::Infallible>>>,
    (StatusCode, Json<serde_json::Value>),
> {
    let bridge = bridge_for(&state.registry, &id).await?;
    let guard = bridge.viewing();
    let init = bridge.init_event();
    let replay = bridge.entry_events();
    let rx = bridge.subscribe();

    struct StreamState {
        queue: VecDeque<SseEvent>,
        rx: broadcast::Receiver<SseEvent>,
        _guard: ViewerGuard,
    }

    let stream_state = StreamState {
        queue: std::iter::once(init).chain(replay).collect(),
        rx,
        _guard: guard,
    };
    let sse_stream = stream::unfold(stream_state, |mut st| async move {
        if let Some(ev) = st.queue.pop_front() {
            return Some((Ok(SseAxumEvent::from(ev)), st));
        }
        loop {
            match st.rx.recv().await {
                Ok(ev) => return Some((Ok(SseAxumEvent::from(ev)), st)),
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    });
    Ok(Sse::new(sse_stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(KEEPALIVE_SECS))
            .text("ping"),
    ))
}

async fn post_prompt(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Form(form): Form<PromptForm>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let bridge = bridge_for(&state.registry, &id).await?;
    match bridge.prompt(&form.message).await {
        Ok(_) => Ok(Json(serde_json::json!({ "ok": true }))),
        Err(err) => Err(cmd_err(err)),
    }
}

async fn post_abort(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let bridge = bridge_for(&state.registry, &id).await?;
    match bridge.abort().await {
        Ok(_) => Ok(Json(serde_json::json!({ "ok": true }))),
        Err(err) => Err(cmd_err(err)),
    }
}

async fn post_model(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Form(form): Form<ModelForm>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let bridge = bridge_for(&state.registry, &id).await?;
    match bridge.set_model(&form.provider, &form.model_id).await {
        Ok(_) => Ok(Json(serde_json::json!({ "ok": true }))),
        Err(err) => Err(cmd_err(err)),
    }
}

async fn post_thinking(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Form(form): Form<ThinkingForm>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let bridge = bridge_for(&state.registry, &id).await?;
    match bridge.set_thinking_level(&form.level).await {
        Ok(_) => Ok(Json(serde_json::json!({ "ok": true }))),
        Err(err) => Err(cmd_err(err)),
    }
}

async fn post_session_name(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Form(form): Form<SessionNameForm>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let bridge = bridge_for(&state.registry, &id).await?;
    match bridge.set_session_name(&form.name).await {
        Ok(_) => Ok(Json(serde_json::json!({ "ok": true }))),
        Err(err) => Err(cmd_err(err)),
    }
}

async fn post_read_only(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Form(form): Form<ReadOnlyForm>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let on = match form.mode.trim().to_lowercase().as_str() {
        "on" | "true" | "1" => true,
        "off" | "false" | "0" => false,
        other => {
            return Err(bridge_err(
                StatusCode::BAD_REQUEST,
                format!("mode must be on|off, got {other:?}"),
            ));
        }
    };
    let bridge = bridge_for(&state.registry, &id).await?;
    match bridge.set_read_only(on).await {
        Ok(_) => Ok(Json(serde_json::json!({ "ok": true }))),
        Err(err) => Err(cmd_err(err)),
    }
}

async fn post_terminate(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    match state.registry.terminate(&id).await {
        Ok(()) => Ok(Json(serde_json::json!({ "ok": true }))),
        Err(err) => Err(cmd_err(err)),
    }
}

async fn get_logs(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Json<serde_json::Value> {
    let stderr = match state.registry.get(&id) {
        Some(bridge) => bridge.log_lines(),
        None => Vec::new(),
    };
    Json(serde_json::json!({ "stderr": stderr }))
}

async fn get_state(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let bridge = bridge_for(&state.registry, &id).await?;
    Ok(Json(bridge.state_snapshot()))
}

async fn get_stats(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let bridge = bridge_for(&state.registry, &id).await?;
    match bridge.session_stats().await {
        Ok(resp) => Ok(Json(
            resp.get("data").cloned().unwrap_or(serde_json::Value::Null),
        )),
        Err(err) => Err(cmd_err(err)),
    }
}

/// Phase 3 chat routes: SSE stream, POST commands, logs/state/stats.
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/agents/{id}/stream", get(sse_stream))
        .route("/api/agents/{id}/prompt", post(post_prompt))
        .route("/api/agents/{id}/abort", post(post_abort))
        .route("/api/agents/{id}/model", post(post_model))
        .route("/api/agents/{id}/thinking", post(post_thinking))
        .route("/api/agents/{id}/session-name", post(post_session_name))
        .route("/api/agents/{id}/read-only", post(post_read_only))
        .route("/api/agents/{id}/terminate", post(post_terminate))
        .route("/api/agents/{id}/logs", get(get_logs))
        .route("/api/agents/{id}/state", get(get_state))
        .route("/api/agents/{id}/stats", get(get_stats))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::fake_pi::{self, FakePi, FakePiOptions, Granularity, ModelInfo};
    use std::path::PathBuf;

    fn test_hub() -> EventHub {
        EventHub::new()
    }

    fn pi_options(id: &str, read_only: bool) -> FakePiOptions {
        FakePiOptions {
            id: id.to_string(),
            project: "alpha".to_string(),
            name: Some("test chat".to_string()),
            read_only,
            general_chat: false,
            granularity: Granularity::Instant,
            models: vec![ModelInfo::mock_default()],
            history: Vec::new(),
            session_file: PathBuf::from(format!("/tmp/dashboard-rs-bridge-test/{id}.jsonl")),
        }
    }

    fn attach_bridge(id: &str, read_only: bool) -> (FakePi, Arc<Bridge>) {
        let pi = FakePi::new(pi_options(id, read_only));
        let attached = pi.create_attach();
        let bridge = Bridge::create(id, "alpha", attached, test_hub(), None);
        (pi, bridge)
    }

    /// Poll until `cond` holds (10s budget); panics with `what` on timeout.
    async fn wait_for(what: &str, mut cond: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !cond() {
            if Instant::now() > deadline {
                panic!("timed out waiting for {what}");
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Drain broadcast events for `ms`, returning (event, data) pairs.
    async fn drain(rx: &mut broadcast::Receiver<SseEvent>, ms: u64) -> Vec<(String, String)> {
        let mut out = Vec::new();
        let deadline = Instant::now() + Duration::from_millis(ms);
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            match tokio::time::timeout(left, rx.recv()).await {
                Ok(Ok(ev)) => out.push((ev.event, ev.data)),
                _ => break,
            }
        }
        out
    }

    #[test]
    fn read_only_regex_matches_extension_texts() {
        assert_eq!(
            parse_read_only("read-only mode is ON (/read-only off to disable)"),
            Some(true)
        );
        assert_eq!(parse_read_only(fake_pi::READ_ONLY_ON_TEXT), Some(true));
        assert_eq!(parse_read_only("read-only mode on"), Some(true));
        assert_eq!(parse_read_only("read-only mode off"), Some(false));
        assert_eq!(parse_read_only("READ-ONLY MODE OFF"), Some(false));
        assert_eq!(parse_read_only("usage: /read-only on|off"), None);
        assert_eq!(parse_read_only("readonly mode on"), None);
        assert_eq!(parse_read_only("read-only mode only"), None);
        assert_eq!(parse_read_only("hello"), None);
    }

    #[test]
    fn committed_entries_render_sanitized_html() {
        // User text is escaped, never Markdown.
        let user = serde_json::json!({
            "type": "message", "id": "u1",
            "message": { "role": "user", "content": "# hi <script>x</script>" },
        });
        let stored = render_committed(&user).unwrap();
        assert_eq!(stored.kind, EntryKind::User);
        assert!(!stored.html.contains("<h1>"), "{}", stored.html);
        assert!(!stored.html.contains("<script>"), "{}", stored.html);
        assert!(stored.html.contains("&lt;script&gt;"), "{}", stored.html);

        // Assistant Markdown renders; scripts are stripped.
        let assistant = serde_json::json!({
            "type": "message", "id": "a1",
            "message": {
                "role": "assistant",
                "content": [
                    { "type": "text", "text": "**bold** <script>evil()</script>" },
                    { "type": "thinking", "thinking": "hmm <b>raw</b>" },
                    { "type": "toolCall", "id": "t1", "name": "bash",
                      "arguments": { "command": "ls -la /tmp/notes here" } },
                ],
            },
        });
        let stored = render_committed(&assistant).unwrap();
        assert_eq!(stored.kind, EntryKind::Assistant);
        assert!(
            stored.html.contains("<strong>bold</strong>"),
            "{}",
            stored.html
        );
        assert!(!stored.html.contains("evil()"), "{}", stored.html);
        assert!(stored.html.contains("thinking"), "{}", stored.html);
        assert!(stored.html.contains("tool-card"), "{}", stored.html);
        assert!(stored.html.contains("ls -la"), "{}", stored.html);

        // Tool results and compactions.
        let result = serde_json::json!({
            "type": "message", "id": "t1r",
            "message": { "role": "toolResult", "toolCallId": "t1", "toolName": "read",
                         "content": [{ "type": "text", "text": "file <bytes>" }], "isError": true },
        });
        let stored = render_committed(&result).unwrap();
        assert_eq!(stored.kind, EntryKind::ToolResult);
        assert!(stored.html.contains("error"), "{}", stored.html);
        assert!(
            stored.html.contains("file &lt;bytes&gt;"),
            "{}",
            stored.html
        );

        let compaction =
            serde_json::json!({ "type": "compaction", "id": "c1", "summary": "did <stuff>" });
        let stored = render_committed(&compaction).unwrap();
        assert_eq!(stored.kind, EntryKind::Compaction);
        assert!(stored.html.contains("context compacted"), "{}", stored.html);
        assert!(stored.html.contains("did &lt;stuff&gt;"), "{}", stored.html);

        // Empty shapes render nothing.
        assert!(
            render_committed(&serde_json::json!({
                "type": "message", "id": "e", "message": { "role": "user", "content": "  " },
            }))
            .is_none()
        );
        assert!(render_committed(&serde_json::json!({ "type": "mystery", "id": "e" })).is_none());
        assert!(render_committed(&serde_json::json!({ "type": "message" })).is_none());
    }

    #[tokio::test]
    async fn seed_loads_state_and_history() {
        let history = vec![
            serde_json::json!({ "type": "message", "id": "h1",
                "message": { "role": "user", "content": "seeded?" } }),
            serde_json::json!({ "type": "message", "id": "h2",
                "message": { "role": "assistant", "content": [{ "type": "text", "text": "seeded **yes**" }] } }),
        ];
        let pi = FakePi::new(FakePiOptions {
            history,
            ..pi_options("seed", false)
        });
        let bridge = Bridge::create("seed", "alpha", pi.create_attach(), test_hub(), None);
        wait_for("seed entries", || bridge.entries.read().unwrap().len() == 2).await;
        wait_for("seed state", || {
            bridge.state.read().unwrap().session_name.is_some()
        })
        .await;

        let init = bridge.init_event();
        assert_eq!(init.event, EVT_INIT);
        let data: serde_json::Value = serde_json::from_str(&init.data).unwrap();
        assert_eq!(data["status"], "idle");
        assert_eq!(data["model"]["id"], "mock-sonnet");
        assert_eq!(data["thinkingLevel"], "medium");
        assert_eq!(data["sessionName"], "test chat");
        assert_eq!(data["entryCount"], 2);
        assert_eq!(data["readOnly"], serde_json::Value::Null);

        let replay = bridge.entry_events();
        assert_eq!(replay.len(), 2);
        assert!(replay.iter().all(|e| e.event == EVT_ENTRY));
        assert!(
            replay[1].data.contains("<strong>yes</strong>"),
            "{}",
            replay[1].data
        );
    }

    #[tokio::test]
    async fn prompt_streams_coalesced_deltas_then_commits() {
        let (_pi, bridge) = attach_bridge("turn", false);
        let mut rx = bridge.subscribe();
        wait_for("seed state", || {
            bridge.state.read().unwrap().session_name.is_some()
        })
        .await;
        // Drain seed chatter (none expected, but be hermetic).
        drain(&mut rx, 100).await;

        bridge.prompt("hello turn").await.unwrap();
        // The turn runs to idle with three committed rows (user echo +
        // toolresult + assistant); the user commit is claimed by the echo.
        wait_for("turn entries", || bridge.entries.read().unwrap().len() == 3).await;
        wait_for("turn idle", || bridge.status() == LiveStatus::Idle).await;
        // Let the trailing broadcasts land.
        let events = drain(&mut rx, 500).await;

        let kinds: Vec<&str> = events.iter().map(|(e, _)| e.as_str()).collect();
        assert!(kinds.contains(&EVT_STATUS), "{kinds:?}");
        assert!(kinds.contains(&EVT_ENTRY), "{kinds:?}");
        assert!(kinds.contains(&EVT_DELTA), "{kinds:?}");

        let entries: Vec<serde_json::Value> = events
            .iter()
            .filter(|(e, _)| e == EVT_ENTRY)
            .map(|(_, d)| serde_json::from_str(d).unwrap())
            .collect();
        let entry_kinds: Vec<String> = entries
            .iter()
            .map(|v| v["kind"].as_str().unwrap().to_string())
            .collect();
        assert!(entry_kinds.contains(&"user".to_string()), "{entry_kinds:?}");
        assert!(
            entry_kinds.contains(&"assistant".to_string()),
            "{entry_kinds:?}"
        );
        // One user row exactly — echo + commit never duplicate.
        assert_eq!(entry_kinds.iter().filter(|k| *k == "user").count(), 1);

        // Streaming overlay: at least one coalesced delta with the reply
        // text, closed by an empty delta when the row landed.
        let deltas: Vec<serde_json::Value> = events
            .iter()
            .filter(|(e, _)| e == EVT_DELTA)
            .map(|(_, d)| serde_json::from_str(d).unwrap())
            .collect();
        assert!(!deltas.is_empty());
        assert!(
            deltas
                .iter()
                .any(|d| d["html"].as_str().unwrap().contains("Mock reply"))
        );
        assert_eq!(deltas.last().unwrap()["html"], "");

        // Status went streaming then back to idle.
        let statuses: Vec<String> = events
            .iter()
            .filter(|(e, _)| e == EVT_STATUS)
            .map(|(_, d)| {
                serde_json::from_str::<serde_json::Value>(d).unwrap()["status"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert!(statuses.contains(&"streaming".to_string()), "{statuses:?}");
        assert!(statuses.contains(&"idle".to_string()), "{statuses:?}");

        // Committed assistant HTML is sanitized Markdown, not raw text.
        let assistant = entries.iter().find(|v| v["kind"] == "assistant").unwrap();
        assert!(
            assistant["html"].as_str().unwrap().contains("Mock reply"),
            "{}",
            assistant["html"]
        );
    }

    #[tokio::test]
    async fn rapid_deltas_coalesce_into_one_flush() {
        let (_pi, bridge) = attach_bridge("coalesce", false);
        let mut rx = bridge.subscribe();
        wait_for("seed state", || {
            bridge.state.read().unwrap().session_name.is_some()
        })
        .await;
        drain(&mut rx, 100).await;

        // Ten synchronous deltas: one flush window, one SSE delta.
        bridge
            .handle_line(serde_json::json!({
                "type": "message_start", "message": { "role": "assistant", "content": [] },
            }))
            .await;
        for i in 0..10 {
            bridge
                .handle_line(serde_json::json!({
                    "type": "message_update",
                    "assistantMessageEvent": { "type": "text_delta", "delta": format!("w{i} ") },
                }))
                .await;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
        let events = drain(&mut rx, 200).await;
        let deltas: Vec<&(String, String)> =
            events.iter().filter(|(e, _)| e == EVT_DELTA).collect();
        assert_eq!(deltas.len(), 1, "{events:?}");
        assert!(deltas[0].1.contains("w0"), "{}", deltas[0].1);
        assert!(deltas[0].1.contains("w9"), "{}", deltas[0].1);
    }

    #[tokio::test]
    async fn dropped_dialogs_and_notifies_become_notices() {
        let (_pi, bridge) = attach_bridge("dialog", false);
        let mut rx = bridge.subscribe();
        wait_for("seed state", || {
            bridge.state.read().unwrap().session_name.is_some()
        })
        .await;
        drain(&mut rx, 100).await;

        bridge.handle_line(serde_json::json!({
            "type": "extension_ui_request", "id": "d1", "method": "select", "message": "pick one",
        })).await;
        bridge
            .handle_line(serde_json::json!({
                "type": "extension_ui_request", "id": "n1", "method": "notify",
                "message": "deployed ok", "notifyType": "info",
            }))
            .await;
        let events = drain(&mut rx, 300).await;
        let notices: Vec<serde_json::Value> = events
            .iter()
            .filter(|(e, _)| e == EVT_NOTICE)
            .map(|(_, d)| serde_json::from_str(d).unwrap())
            .collect();
        assert_eq!(notices.len(), 2, "{notices:?}");
        assert_eq!(notices[0]["key"], "dialog");
        assert_eq!(notices[0]["level"], "warning");
        assert!(notices[0]["text"].as_str().unwrap().contains("select"));
        assert_eq!(notices[1]["text"], "deployed ok");
        assert_eq!(notices[1]["level"], "info");
    }

    #[tokio::test]
    async fn read_only_notify_updates_cached_state() {
        let (_pi, bridge) = attach_bridge("ro", false);
        let mut rx = bridge.subscribe();
        wait_for("seed state", || {
            bridge.state.read().unwrap().session_name.is_some()
        })
        .await;
        drain(&mut rx, 100).await;

        bridge
            .handle_line(serde_json::json!({
                "type": "extension_ui_request", "id": "n1", "method": "notify",
                "message": "read-only mode is ON (/read-only off to disable)", "notifyType": "info",
            }))
            .await;
        wait_for("read-only cached", || {
            bridge.read_only.read().unwrap().is_some()
        })
        .await;
        assert_eq!(*bridge.read_only.read().unwrap(), Some(true));

        let events = drain(&mut rx, 300).await;
        let notice = events.iter().find(|(e, _)| e == EVT_NOTICE).unwrap();
        let data: serde_json::Value = serde_json::from_str(&notice.1).unwrap();
        assert_eq!(data["key"], "read-only");
        assert_eq!(data["state"]["readOnly"], true);

        // Late joiners learn the mode from init.
        let init: serde_json::Value = serde_json::from_str(&bridge.init_event().data).unwrap();
        assert_eq!(init["readOnly"], true);
    }

    #[tokio::test]
    async fn read_only_attach_seeds_startup_notify() {
        let (_pi, bridge) = attach_bridge("ro-seed", true);
        wait_for("startup read-only", || {
            bridge.read_only.read().unwrap().is_some()
        })
        .await;
        assert_eq!(*bridge.read_only.read().unwrap(), Some(true));
    }

    #[tokio::test]
    async fn state_mutations_refresh_cache_and_fan_out() {
        let hub = test_hub();
        let mut hub_rx = hub.subscribe();
        let pi = FakePi::new(pi_options("mut", false));
        let bridge = Bridge::create("mut", "alpha", pi.create_attach(), hub, None);
        let mut rx = bridge.subscribe();
        wait_for("seed state", || {
            bridge.state.read().unwrap().session_name.is_some()
        })
        .await;
        drain(&mut rx, 100).await;

        bridge.set_model("openrouter", "mock-haiku").await.unwrap();
        wait_for("model sticks", || {
            bridge
                .state
                .read()
                .unwrap()
                .model
                .as_ref()
                .is_some_and(|m| m.id == "mock-haiku")
        })
        .await;
        bridge.set_thinking_level("high").await.unwrap();
        wait_for("thinking sticks", || {
            bridge.state.read().unwrap().thinking_level.as_deref() == Some("high")
        })
        .await;
        bridge.set_session_name("renamed chat").await.unwrap();
        wait_for("name sticks", || {
            bridge.state.read().unwrap().session_name.as_deref() == Some("renamed chat")
        })
        .await;

        let events = drain(&mut rx, 300).await;
        let notices: Vec<serde_json::Value> = events
            .iter()
            .filter(|(e, _)| e == EVT_NOTICE)
            .map(|(_, d)| serde_json::from_str(d).unwrap())
            .collect();
        assert!(
            notices
                .iter()
                .any(|n| n["key"] == "model" && n["state"]["model"]["id"] == "mock-haiku"),
            "{notices:?}"
        );
        assert!(
            notices
                .iter()
                .any(|n| n["key"] == "thinking" && n["state"]["thinkingLevel"] == "high"),
            "{notices:?}"
        );
        // Renames are silent state patches (no toast text on first-message titling).
        let rename = notices.iter().find(|n| n["key"] == "session").unwrap();
        assert!(rename.get("text").is_none(), "{rename}");
        assert_eq!(rename["state"]["sessionName"], "renamed chat");

        // …but the rename still nudges the global agent feed.
        let hub_ev = tokio::time::timeout(Duration::from_secs(2), hub_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            hub_ev,
            GlobalEvent::AgentsChanged {
                action: "rename".to_string(),
                id: "mut".to_string()
            }
        );
    }

    #[tokio::test]
    async fn explicit_name_survives_state_refresh() {
        let pi = FakePi::new(pi_options("named", false));
        let bridge = Bridge::create(
            "named",
            "alpha",
            pi.create_attach(),
            test_hub(),
            Some("my title".to_string()),
        );
        wait_for("pinned name", || {
            bridge.state.read().unwrap().session_name.as_deref() == Some("my title")
        })
        .await;
    }

    #[tokio::test]
    async fn read_only_toggle_and_stats_round_trip() {
        let (_pi, bridge) = attach_bridge("slash", false);
        wait_for("seed state", || {
            bridge.state.read().unwrap().session_name.is_some()
        })
        .await;
        bridge.set_read_only(true).await.unwrap();
        wait_for("toggled on", || {
            *bridge.read_only.read().unwrap() == Some(true)
        })
        .await;
        let stats = bridge.session_stats().await.unwrap();
        assert_eq!(stats["data"]["contextUsage"]["percent"], 30);
    }

    #[tokio::test]
    async fn stderr_seed_feeds_the_logs_ring() {
        let (_pi, bridge) = attach_bridge("logs", false);
        wait_for("logs seeded", || !bridge.log_lines().is_empty()).await;
        let logs = bridge.log_lines();
        assert!(
            logs.iter().any(|l| l.starts_with("fake-pi ready")),
            "{logs:?}"
        );
        assert!(logs.len() <= LOG_CAP);
    }

    #[tokio::test]
    async fn abort_freezes_the_streamed_prefix() {
        let pi = FakePi::new(FakePiOptions {
            granularity: Granularity::Word,
            ..pi_options("abort", false)
        });
        let bridge = Bridge::create("abort", "alpha", pi.create_attach(), test_hub(), None);
        let mut rx = bridge.subscribe();
        wait_for("seed state", || {
            bridge.state.read().unwrap().session_name.is_some()
        })
        .await;
        drain(&mut rx, 100).await;

        bridge.prompt("a long reply please").await.unwrap();
        // Let a few word-deltas stream, then abort mid-turn.
        tokio::time::sleep(Duration::from_millis(150)).await;
        bridge.abort().await.unwrap();
        wait_for("settled after abort", || {
            bridge.status() == LiveStatus::Idle
                && bridge
                    .entries
                    .read()
                    .unwrap()
                    .iter()
                    .any(|e| e.html.contains("stopped — reply truncated"))
        })
        .await;
        let _ = drain(&mut rx, 200).await;
    }

    #[tokio::test]
    async fn pi_close_marks_exited_and_commands_go_gone() {
        let (pi, bridge) = attach_bridge("exit", false);
        let mut rx = bridge.subscribe();
        wait_for("seed state", || {
            bridge.state.read().unwrap().session_name.is_some()
        })
        .await;
        pi.close();
        wait_for("exited", || bridge.status() == LiveStatus::Exited).await;
        let events = drain(&mut rx, 500).await;
        assert!(
            events
                .iter()
                .any(|(e, d)| e == EVT_STATUS && d.contains("exited")),
            "{events:?}"
        );
        assert!(matches!(
            bridge.prompt("hi").await,
            Err(BridgeError::Exited)
        ));
    }

    #[tokio::test]
    async fn viewer_disconnect_never_stops_the_agent() {
        let (_pi, bridge) = attach_bridge("viewers", false);
        wait_for("seed state", || {
            bridge.state.read().unwrap().session_name.is_some()
        })
        .await;
        assert_eq!(bridge.client_count(), 0);
        {
            let _a = bridge.viewing();
            let _b = bridge.viewing();
            assert_eq!(bridge.client_count(), 2);
        }
        assert_eq!(bridge.client_count(), 0);
        assert_ne!(bridge.status(), LiveStatus::Exited);
        // Still fully usable after every viewer leaves.
        bridge.prompt("still here").await.unwrap();
        wait_for("turn ran", || bridge.entries.read().unwrap().len() == 3).await;
    }

    // ---- registry -----------------------------------------------------------

    fn mock_registry(scenario: &str) -> (Arc<SelectedRuntime>, Arc<BridgeRegistry>) {
        let dir = PathBuf::from("/tmp/dashboard-rs-bridge-registry-test");
        let mock = crate::runtime::mock::MockRuntime::from_scenario(scenario, &dir).unwrap();
        let runtime = Arc::new(SelectedRuntime::Mock(Arc::new(mock)));
        let registry = Arc::new(BridgeRegistry::new(Arc::clone(&runtime), EventHub::new()));
        (runtime, registry)
    }

    #[tokio::test]
    async fn ensure_attaches_once_and_guards_non_agents() {
        let (runtime, registry) = mock_registry("sidebar-full");
        let id = runtime.list().await.unwrap()[0].id.clone();
        let first = registry.ensure(&id, None).await.unwrap();
        let second = registry.ensure(&id, None).await.unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(first.project(), "alpha");

        assert!(matches!(
            registry.ensure("nope", None).await,
            Err(RegistryError::Unknown(_))
        ));
    }

    #[tokio::test]
    async fn terminate_broadcasts_exited_then_drops() {
        let (runtime, registry) = mock_registry("sidebar-full");
        let id = runtime.list().await.unwrap()[0].id.clone();
        let bridge = registry.ensure(&id, None).await.unwrap();
        let mut rx = bridge.subscribe();
        let mut hub_rx = registry.hub().subscribe();
        wait_for("seed state", || {
            bridge.state.read().unwrap().session_name.is_some()
        })
        .await;
        drain(&mut rx, 100).await;

        registry.terminate(&id).await.unwrap();
        assert!(registry.get(&id).is_none());
        assert!(runtime.list().await.unwrap().iter().all(|a| a.id != id));

        let events = drain(&mut rx, 300).await;
        assert!(
            events
                .iter()
                .any(|(e, d)| e == EVT_STATUS && d.contains("exited")),
            "{events:?}"
        );
        let hub_ev = tokio::time::timeout(Duration::from_secs(2), hub_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            hub_ev,
            GlobalEvent::AgentStatus {
                id: id.clone(),
                project: "alpha".to_string(),
                status: "exited".to_string(),
            }
        );
        // Terminate is idempotent; commands on the husk are Gone.
        registry.terminate(&id).await.unwrap();
        assert!(matches!(
            bridge.prompt("hi").await,
            Err(BridgeError::Exited)
        ));
    }

    #[tokio::test]
    async fn prune_exited_keeps_fresh_and_viewed_bridges() {
        let (runtime, registry) = mock_registry("sidebar-full");
        let agents = runtime.list().await.unwrap();
        let (a, b) = (agents[0].id.clone(), agents[1].id.clone());
        let ba = registry.ensure(&a, None).await.unwrap();
        let bb = registry.ensure(&b, None).await.unwrap();
        wait_for("seeded", || {
            ba.state.read().unwrap().session_name.is_some()
                && bb.state.read().unwrap().session_name.is_some()
        })
        .await;

        // Fresh exit: kept. Ancient exit with a viewer: kept.
        ba.set_status(LiveStatus::Exited);
        let _guard = bb.viewing();
        bb.set_status(LiveStatus::Exited);
        bb.set_idle_since(Instant::now() - Duration::from_secs(3600));
        bb.set_exited_at(Instant::now() - Duration::from_secs(3600));
        assert_eq!(registry.prune_exited(Instant::now()), 0);

        // Ancient exit, no viewers: pruned.
        ba.set_idle_since(Instant::now() - Duration::from_secs(3600));
        ba.set_exited_at(Instant::now() - Duration::from_secs(3600));
        assert_eq!(registry.prune_exited(Instant::now()), 1);
        assert!(registry.get(&a).is_none());
        assert!(registry.get(&b).is_some());
    }
}

#[cfg(test)]
mod http_tests {
    use super::*;
    use crate::runtime::SpawnOptions;
    use std::net::SocketAddr;
    use std::path::PathBuf;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn raw_request(addr: SocketAddr, req: &str) -> String {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        stream.write_all(req.as_bytes()).await.unwrap();
        let mut buf = Vec::new();
        // Keepalive streams never close: read until the assertion bytes
        // arrive, then stop (3s budget).
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            let mut chunk = [0u8; 4096];
            match tokio::time::timeout(left, stream.read(&mut chunk)).await {
                Ok(Ok(0)) | Err(_) => break,
                Ok(Ok(n)) => {
                    buf.extend_from_slice(&chunk[..n]);
                    let s = String::from_utf8_lossy(&buf);
                    if s.contains("event: init")
                        || s.contains("HTTP/1.1 404")
                        || s.contains("HTTP/1.1 200")
                    {
                        // For non-streaming responses the server closes the
                        // connection; keep reading only for the SSE case.
                        if s.contains("text/event-stream") && s.contains("event: init") {
                            break;
                        }
                        if !s.contains("text/event-stream") {
                            continue;
                        }
                    }
                }
                Ok(Err(_)) => break,
            }
        }
        String::from_utf8_lossy(&buf).into_owned()
    }

    async fn serve() -> (SocketAddr, Arc<SelectedRuntime>) {
        let dir = PathBuf::from("/tmp/dashboard-rs-bridge-http-test");
        let mock = crate::runtime::mock::MockRuntime::from_scenario("empty", &dir).unwrap();
        let runtime = Arc::new(SelectedRuntime::Mock(Arc::new(mock)));
        let registry = Arc::new(BridgeRegistry::new(Arc::clone(&runtime), EventHub::new()));
        // Router construction itself panics on bad axum path syntax.
        let app = router(AppState::new(registry));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (addr, runtime)
    }

    #[tokio::test]
    async fn chat_api_unknown_agent_contract() {
        let (addr, _rt) = serve().await;
        let body = raw_request(
            addr,
            "GET /api/agents/nope/state HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(body.contains("HTTP/1.1 404"), "{body}");
        assert!(body.contains("unknown agent"), "{body}");

        let body = raw_request(
            addr,
            "GET /api/agents/nope/logs HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(body.contains("HTTP/1.1 200"), "{body}");
        assert!(body.contains("\"stderr\":[]"), "{body}");

        let form = "message=hi";
        let body = raw_request(
            addr,
            &format!(
                "POST /api/agents/nope/prompt HTTP/1.1\r\nHost: x\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{form}",
                form.len()
            ),
        )
        .await;
        assert!(body.contains("HTTP/1.1 404"), "{body}");
    }

    #[tokio::test]
    async fn chat_stream_serves_init_over_sse() {
        let (addr, runtime) = serve().await;
        let id = runtime
            .spawn(SpawnOptions::jarvis(PathBuf::from(
                "/home/dev/projects/alpha",
            )))
            .await
            .unwrap();
        let body = raw_request(
            addr,
            &format!("GET /api/agents/{id}/stream HTTP/1.1\r\nHost: x\r\nAccept: text/event-stream\r\n\r\n"),
        )
        .await;
        assert!(body.contains("HTTP/1.1 200"), "{body}");
        assert!(body.contains("text/event-stream"), "{body}");
        assert!(body.contains("event: init"), "{body}");
        assert!(body.contains("\"status\":\"idle\""), "{body}");
    }
}
