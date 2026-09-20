//! FakePi — scripted `pi --mode rpc` stand-in for mock mode.
//!
//! Port of `dashboard/server/mock/fake-pi.ts`: one instance per agent
//! session owns the shared entry log, creates per-attach stdio line
//! channels, and answers one JSONL command per stdin line. The
//! command/event catalog matches the old one exactly (`get_state`,
//! `set_model`, `set_thinking_level`, `set_session_name`,
//! `get_available_models`, `get_available_thinking_levels`,
//! `get_session_stats`, `get_entries`, `prompt`, `abort`; `/read-only`
//! slash commands); responses echo the command's `id` and name the command,
//! events fan out to every attach, responses go only to the requester.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use super::AttachedAgent;

/// Reply streaming granularity (old `StreamGranularity`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Granularity {
    Char,
    Word,
    Instant,
}

/// Parse `MOCK_GRANULARITY`-style values; unknown (or missing) is `word`,
/// matching the old default.
pub fn parse_granularity(raw: Option<&str>) -> Granularity {
    match raw.map(str::trim) {
        Some("char") => Granularity::Char,
        Some("instant") => Granularity::Instant,
        _ => Granularity::Word,
    }
}

/// One pi model entry (old `MockModel`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelInfo {
    pub provider: String,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(rename = "contextWindow", skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
}

impl ModelInfo {
    pub fn mock_default() -> Self {
        Self {
            provider: "openrouter".to_string(),
            id: "mock-sonnet".to_string(),
            name: Some("Mock Sonnet".to_string()),
            context_window: Some(200_000),
        }
    }

    /// The mock catalog (mirrors `testdata/mock/models.json`).
    pub fn mock_catalog() -> Vec<Self> {
        vec![
            Self::mock_default(),
            Self {
                provider: "openrouter".to_string(),
                id: "mock-haiku".to_string(),
                name: Some("Mock Haiku".to_string()),
                context_window: Some(100_000),
            },
            Self {
                provider: "openrouter".to_string(),
                id: "mock-opus".to_string(),
                name: Some("Mock Opus".to_string()),
                context_window: Some(200_000),
            },
        ]
    }
}

const DEFAULT_LEVELS: &[&str] = &["low", "medium", "high"];

/// Announced at session start when the agent starts read-only, and on every
/// `/read-only on|off` — the exact texts the bridge regexes (matches the
/// real read-only extension).
pub const READ_ONLY_ON_TEXT: &str = "read-only mode is ON (/read-only off to disable)";

/// Construction parameters (old `FakePiOptions`).
#[derive(Clone, Debug)]
pub struct FakePiOptions {
    pub id: String,
    pub project: String,
    /// Spawn display name. `None` stays untitled until the first message
    /// titles it via `set_session_name` — no placeholder names.
    pub name: Option<String>,
    pub read_only: bool,
    pub general_chat: bool,
    pub granularity: Granularity,
    pub models: Vec<ModelInfo>,
    pub history: Vec<serde_json::Value>,
    pub session_file: PathBuf,
}

/// Scripted pi session. `Clone` shares the session: every attach sees the
/// same entry log and live events.
#[derive(Clone, Debug)]
pub struct FakePi {
    inner: Arc<Mutex<Inner>>,
}

#[derive(Debug)]
struct Inner {
    id: String,
    project: String,
    model: ModelInfo,
    thinking_level: String,
    session_name: String,
    session_file: PathBuf,
    read_only: bool,
    general_chat: bool,
    granularity: Granularity,
    models: Vec<ModelInfo>,
    entries: Vec<serde_json::Value>,
    leaf_id: Option<String>,
    entry_seq: u64,
    subscribers: Vec<mpsc::UnboundedSender<String>>,
    stderr_senders: Vec<mpsc::UnboundedSender<String>>,
    /// Per-attach stdin pumps. Aborted on `close` so no sender outlives
    /// the session (a lingering sender would keep `stdout` open and the
    /// bridge would never observe the exit).
    tasks: Vec<tokio::task::JoinHandle<()>>,
    streaming: bool,
    pending_prompt: Option<String>,
    /// Bumped by `abort` and `close`; turn tasks check it per step.
    generation: u64,
    notify_seq: u64,
    closed: bool,
}

impl FakePi {
    pub fn new(opts: FakePiOptions) -> Self {
        let models = if opts.models.is_empty() {
            vec![ModelInfo::mock_default()]
        } else {
            opts.models
        };
        let model = models[0].clone();
        let mut inner = Inner {
            id: opts.id,
            project: opts.project,
            model,
            thinking_level: "medium".to_string(),
            session_name: opts.name.unwrap_or_default(),
            session_file: opts.session_file,
            read_only: opts.read_only,
            general_chat: opts.general_chat,
            granularity: opts.granularity,
            models,
            entries: Vec::new(),
            leaf_id: None,
            entry_seq: 0,
            subscribers: Vec::new(),
            stderr_senders: Vec::new(),
            tasks: Vec::new(),
            streaming: false,
            pending_prompt: None,
            generation: 0,
            notify_seq: 0,
            closed: false,
        };
        for entry in opts.history {
            if entry.get("id").and_then(|v| v.as_str()).is_some() {
                if let Some(id) = entry.get("id").and_then(|v| v.as_str())
                    && let Some(n) = id.strip_prefix('e').and_then(|s| s.parse().ok())
                {
                    inner.entry_seq = inner.entry_seq.max(n);
                }
                inner.leaf_id = entry.get("id").and_then(|v| v.as_str()).map(str::to_string);
                inner.entries.push(entry);
            }
        }
        Self {
            inner: Arc::new(Mutex::new(inner)),
        }
    }

    /// Load resume history from a pi session file: `message`/`compaction`
    /// entries (with ids) become the entry log; the name comes from the
    /// first `session_info`. `None` when the file is unreadable.
    pub fn load_resume(path: &Path) -> Option<(Vec<serde_json::Value>, Option<String>)> {
        let raw = std::fs::read_to_string(path).ok()?;
        let mut entries = Vec::new();
        let mut name = None;
        for line in raw.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(obj) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            if obj.get("type").and_then(|v| v.as_str()) == Some("session_info")
                && name.is_none()
                && let Some(n) = obj.get("name").and_then(|v| v.as_str())
            {
                name = Some(n.to_string());
            }
            let is_entry = matches!(
                obj.get("type").and_then(|v| v.as_str()),
                Some("message") | Some("compaction")
            );
            if is_entry && obj.get("id").and_then(|v| v.as_str()).is_some() {
                entries.push(obj);
            }
        }
        Some((entries, name))
    }

    /// Open stdio to this session. Responses route to this attach; events
    /// fan out to every attach.
    pub fn create_attach(&self) -> AttachedAgent {
        let (stdin_tx, stdin_rx) = mpsc::unbounded_channel::<String>();
        let (stdout_tx, stdout_rx) = mpsc::unbounded_channel::<String>();
        let (stderr_tx, stderr_rx) = mpsc::unbounded_channel::<String>();
        let closed = self.inner.lock().unwrap().closed;
        if closed {
            // Attaching to a stopped agent: hand back already-closing pipes
            // so the bridge's exited path fires, like a real stop.
            drop(stdout_tx);
            drop(stderr_tx);
            drop(stdin_rx);
            return AttachedAgent {
                stdin_tx,
                stdout_rx,
                stderr_rx,
            };
        }
        let seed: Vec<String>;
        let read_only: bool;
        let reply_tx = stdout_tx.clone();
        let notify_tx = stdout_tx.clone();
        let this = self.clone();
        let handle = tokio::spawn(async move {
            let mut stdin_rx = stdin_rx;
            while let Some(line) = stdin_rx.recv().await {
                if this.is_closed() {
                    break;
                }
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<serde_json::Value>(&line) {
                    Ok(cmd) => this.handle_command(&cmd, &reply_tx),
                    Err(_) => { /* unparseable input — ignore, like pi */ }
                }
            }
        });
        {
            let mut inner = self.inner.lock().unwrap();
            inner.subscribers.push(stdout_tx);
            inner.tasks.retain(|h| !h.is_finished());
            inner.tasks.push(handle);
            seed = inner.stderr_seed();
            read_only = inner.read_only;
            inner.stderr_senders.push(stderr_tx.clone());
        }
        for line in seed {
            let _ = stderr_tx.send(line);
        }
        // Deferred a tick so the bridge has wired its stdout listener.
        if read_only {
            let this = self.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                this.notify(READ_ONLY_ON_TEXT, "info", Some(&notify_tx));
            });
        }
        AttachedAgent {
            stdin_tx,
            stdout_rx,
            stderr_rx,
        }
    }

    /// Close all pipes (mock stop): drives the bridge's exited path.
    pub fn close(&self) {
        let mut inner = self.inner.lock().unwrap();
        if inner.closed {
            return;
        }
        inner.closed = true;
        inner.generation += 1;
        inner.streaming = false;
        inner.pending_prompt = None;
        for handle in inner.tasks.drain(..) {
            handle.abort();
        }
        inner.subscribers.clear();
        inner.stderr_senders.clear();
    }

    fn is_closed(&self) -> bool {
        self.inner.lock().unwrap().closed
    }

    // ---- protocol ---------------------------------------------------------

    fn respond(
        cmd: &serde_json::Value,
        success: bool,
        data: Option<serde_json::Value>,
        error: Option<&str>,
    ) -> String {
        let mut resp = serde_json::Map::new();
        resp.insert(
            "type".to_string(),
            serde_json::Value::String("response".to_string()),
        );
        if let Some(t) = cmd.get("type").and_then(|v| v.as_str()) {
            resp.insert(
                "command".to_string(),
                serde_json::Value::String(t.to_string()),
            );
        }
        if let Some(id) = cmd.get("id").and_then(|v| v.as_str()) {
            resp.insert("id".to_string(), serde_json::Value::String(id.to_string()));
        }
        resp.insert("success".to_string(), serde_json::Value::Bool(success));
        if success {
            if let Some(data) = data {
                resp.insert("data".to_string(), data);
            }
        } else if let Some(error) = error {
            resp.insert(
                "error".to_string(),
                serde_json::Value::String(error.to_string()),
            );
        }
        serde_json::Value::Object(resp).to_string()
    }

    fn emit_to(tx: &mpsc::UnboundedSender<String>, value: &serde_json::Value) {
        let _ = tx.send(value.to_string());
    }

    fn broadcast(&self, value: &serde_json::Value) {
        let line = value.to_string();
        let mut inner = self.inner.lock().unwrap();
        inner.subscribers.retain(|tx| tx.send(line.clone()).is_ok());
    }

    fn notify(
        &self,
        message: &str,
        notify_type: &str,
        only: Option<&mpsc::UnboundedSender<String>>,
    ) {
        let note = {
            let mut inner = self.inner.lock().unwrap();
            inner.notify_seq += 1;
            serde_json::json!({
                "type": "extension_ui_request",
                "id": format!("notify-{}-{}", inner.id, inner.notify_seq),
                "method": "notify",
                "message": message,
                "notifyType": notify_type,
            })
        };
        if let Some(tx) = only {
            Self::emit_to(tx, &note);
        } else {
            self.broadcast(&note);
        }
    }

    fn next_entry_id(inner: &mut Inner) -> String {
        inner.entry_seq += 1;
        format!("e{}", inner.entry_seq)
    }

    fn append_entry(&self, mut entry: serde_json::Value) {
        let mut inner = self.inner.lock().unwrap();
        let id = entry
            .get("id")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| Self::next_entry_id(&mut inner));
        if let Some(obj) = entry.as_object_mut() {
            obj.insert("id".to_string(), serde_json::Value::String(id.clone()));
        }
        inner.entries.push(entry);
        inner.leaf_id = Some(id);
    }

    fn handle_command(&self, cmd: &serde_json::Value, reply_to: &mpsc::UnboundedSender<String>) {
        if self.is_closed() {
            return;
        }
        let cmd_type = cmd.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match cmd_type {
            "get_state" => {
                let inner = self.inner.lock().unwrap();
                let _ = reply_to.send(Self::respond(
                    cmd,
                    true,
                    Some(serde_json::json!({
                        "model": inner.model,
                        "thinkingLevel": inner.thinking_level,
                        "sessionName": inner.session_name,
                        "sessionFile": inner.session_file.to_string_lossy(),
                    })),
                    None,
                ));
            }
            "set_model" => {
                let provider = cmd.get("provider").and_then(|v| v.as_str());
                let model_id = cmd.get("modelId").and_then(|v| v.as_str());
                match (provider, model_id) {
                    (Some(provider), Some(model_id)) => {
                        let mut inner = self.inner.lock().unwrap();
                        let found = inner
                            .models
                            .iter()
                            .find(|m| m.provider == provider && m.id == model_id)
                            .cloned();
                        inner.model = found.unwrap_or(ModelInfo {
                            provider: provider.to_string(),
                            id: model_id.to_string(),
                            name: Some(model_id.to_string()),
                            context_window: None,
                        });
                        let model = inner.model.clone();
                        drop(inner);
                        let _ = reply_to.send(Self::respond(
                            cmd,
                            true,
                            Some(serde_json::to_value(&model).unwrap()),
                            None,
                        ));
                    }
                    _ => {
                        let _ = reply_to.send(Self::respond(
                            cmd,
                            false,
                            None,
                            Some("provider and modelId are required"),
                        ));
                    }
                }
            }
            "set_thinking_level" => match cmd.get("level").and_then(|v| v.as_str()) {
                Some(level) => {
                    self.inner.lock().unwrap().thinking_level = level.to_string();
                    let _ = reply_to.send(Self::respond(cmd, true, None, None));
                }
                None => {
                    let _ =
                        reply_to.send(Self::respond(cmd, false, None, Some("level is required")));
                }
            },
            "set_session_name" => match cmd.get("name").and_then(|v| v.as_str()) {
                Some(name) => {
                    self.inner.lock().unwrap().session_name = name.to_string();
                    let _ = reply_to.send(Self::respond(cmd, true, None, None));
                }
                None => {
                    let _ =
                        reply_to.send(Self::respond(cmd, false, None, Some("name is required")));
                }
            },
            "get_available_models" => {
                let inner = self.inner.lock().unwrap();
                let models = inner.models.clone();
                drop(inner);
                let _ = reply_to.send(Self::respond(
                    cmd,
                    true,
                    Some(serde_json::json!({ "models": models })),
                    None,
                ));
            }
            "get_available_thinking_levels" => {
                let _ = reply_to.send(Self::respond(
                    cmd,
                    true,
                    Some(serde_json::json!({ "levels": DEFAULT_LEVELS })),
                    None,
                ));
            }
            "get_session_stats" => {
                let inner = self.inner.lock().unwrap();
                let (session_file, id) = (
                    inner.session_file.to_string_lossy().to_string(),
                    inner.id.clone(),
                );
                drop(inner);
                let _ = reply_to.send(Self::respond(
                    cmd,
                    true,
                    Some(serde_json::json!({
                        "sessionFile": session_file,
                        "sessionId": id,
                        "userMessages": 2,
                        "assistantMessages": 2,
                        "toolCalls": 1,
                        "toolResults": 1,
                        "totalMessages": 6,
                        "tokens": { "input": 50000, "output": 10000, "cacheRead": 40000, "cacheWrite": 5000, "total": 105000 },
                        "cost": 0.45,
                        "contextUsage": { "tokens": 60000, "contextWindow": 200000, "percent": 30 },
                    })),
                    None,
                ));
            }
            "get_entries" => {
                let inner = self.inner.lock().unwrap();
                match cmd.get("since").and_then(|v| v.as_str()) {
                    Some(since) => match inner
                        .entries
                        .iter()
                        .position(|e| e.get("id").and_then(|v| v.as_str()) == Some(since))
                    {
                        Some(idx) => {
                            let entries = inner.entries[idx + 1..].to_vec();
                            let leaf_id = inner.leaf_id.clone();
                            drop(inner);
                            let _ = reply_to.send(Self::respond(
                                cmd,
                                true,
                                Some(serde_json::json!({ "entries": entries, "leafId": leaf_id })),
                                None,
                            ));
                        }
                        None => {
                            drop(inner);
                            let _ = reply_to.send(Self::respond(
                                cmd,
                                false,
                                None,
                                Some("unknown cursor"),
                            ));
                        }
                    },
                    None => {
                        let entries = inner.entries.clone();
                        let leaf_id = inner.leaf_id.clone();
                        drop(inner);
                        let _ = reply_to.send(Self::respond(
                            cmd,
                            true,
                            Some(serde_json::json!({ "entries": entries, "leafId": leaf_id })),
                            None,
                        ));
                    }
                }
            }
            "prompt" => match cmd.get("message").and_then(|v| v.as_str()) {
                Some(message) if message.starts_with('/') => {
                    self.handle_slash(message, cmd, reply_to);
                }
                Some(message) => {
                    let message = message.to_string();
                    let _ = reply_to.send(Self::respond(cmd, true, None, None));
                    let mut inner = self.inner.lock().unwrap();
                    if inner.streaming {
                        // Buffer at most one pending prompt; the client
                        // blocks these anyway except slashes.
                        inner.pending_prompt = Some(message);
                    } else {
                        drop(inner);
                        self.run_turn(&message);
                    }
                }
                None => {
                    let _ =
                        reply_to.send(Self::respond(cmd, false, None, Some("message is required")));
                }
            },
            "abort" => {
                {
                    let mut inner = self.inner.lock().unwrap();
                    inner.generation += 1;
                    inner.pending_prompt = None;
                    inner.streaming = false;
                }
                self.broadcast(&serde_json::json!({ "type": "agent_settled" }));
                let _ = reply_to.send(Self::respond(cmd, true, None, None));
            }
            other => {
                let _ = reply_to.send(Self::respond(
                    cmd,
                    false,
                    None,
                    Some(&format!("unknown command: {other}")),
                ));
            }
        }
    }

    fn handle_slash(
        &self,
        message: &str,
        cmd: &serde_json::Value,
        reply_to: &mpsc::UnboundedSender<String>,
    ) {
        let trimmed = message.trim();
        if trimmed.len() >= "/read-only".len()
            && trimmed[.."/read-only".len()].eq_ignore_ascii_case("/read-only")
        {
            match trimmed["/read-only".len()..].trim().to_lowercase().as_str() {
                "on" => {
                    self.inner.lock().unwrap().read_only = true;
                    let _ = reply_to.send(Self::respond(cmd, true, None, None));
                    self.notify("read-only mode on", "info", None);
                }
                "off" => {
                    self.inner.lock().unwrap().read_only = false;
                    let _ = reply_to.send(Self::respond(cmd, true, None, None));
                    self.notify("read-only mode off", "warning", None);
                }
                _ => {
                    let _ = reply_to.send(Self::respond(cmd, true, None, None));
                    self.notify("usage: /read-only on|off", "warning", None);
                }
            }
            return;
        }
        // Other slash commands: ack, no turn (matches prod).
        let _ = reply_to.send(Self::respond(cmd, true, None, None));
    }

    // ---- scripted turn ------------------------------------------------------

    fn run_turn(&self, prompt: &str) {
        let steps = {
            let mut inner = self.inner.lock().unwrap();
            inner.streaming = true;
            let generation = inner.generation;
            let model_id = inner.model.id.clone();
            drop(inner);
            (self.build_turn(prompt, &model_id), generation)
        };
        let (steps, generation) = steps;
        let this = self.clone();
        tokio::spawn(async move {
            for (delay_ms, op) in steps {
                if delay_ms > 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                }
                if !this.step_guard(generation) {
                    return;
                }
                match op {
                    TurnOp::Event(ev) => this.broadcast(&ev),
                    TurnOp::Append(entry) => this.append_entry(entry),
                }
            }
            let next = {
                let mut inner = this.inner.lock().unwrap();
                if inner.generation != generation || inner.closed {
                    return;
                }
                inner.streaming = false;
                inner.pending_prompt.take()
            };
            this.broadcast(&serde_json::json!({ "type": "agent_settled" }));
            // A prompt buffered mid-turn runs now (matches the old `later`
            // wrapper's settle hook).
            if let Some(next) = next
                && !this.is_closed()
            {
                this.run_turn(&next);
            }
        });
    }

    /// The turn task may proceed only while its generation is current and
    /// the session is open (`abort`/`close` bump or close out from under it).
    fn step_guard(&self, generation: u64) -> bool {
        let inner = self.inner.lock().unwrap();
        !inner.closed && inner.generation == generation
    }

    /// Scripted turn as `(delay-after-previous-ms, op)` steps. Entry payloads
    /// double as the broadcast bodies so ids stay stable (`e1, e2, …`).
    fn build_turn(&self, prompt: &str, model_id: &str) -> Vec<(u64, TurnOp)> {
        let inner = self.inner.lock().unwrap();
        let (deltas, per_delta_ms) = split_deltas(&inner.granularity, prompt);
        drop(inner);
        let user_text = prompt.to_string();
        let prose = format!(
            "Mock reply to: \"{user_text}\"\n\nThis is a scripted reply. It echoes your prompt."
        );
        let thinking_text = "Considering the request…".to_string();
        let tool_args = serde_json::json!({ "path": "notes/example.md" });
        let tool_args_json = tool_args.to_string();
        let tool_result_text = "# notes/example.md (mock)\n\nScripted tool result.".to_string();
        let full_assistant_text = format!("{prose}\n\nRead `notes/example.md` for context.");

        let user_entry = serde_json::json!({
            "type": "message",
            "message": { "role": "user", "content": user_text },
        });
        let tool_result_entry = serde_json::json!({
            "type": "message",
            "message": {
                "role": "toolResult",
                "toolCallId": "t1",
                "toolName": "read",
                "content": [{ "type": "text", "text": tool_result_text }],
            },
        });
        let assistant_entry = serde_json::json!({
            "type": "message",
            "message": {
                "role": "assistant",
                "content": [
                    { "type": "text", "text": full_assistant_text },
                    { "type": "toolCall", "id": "t1", "name": "read", "arguments": tool_args },
                ],
                "model": model_id,
            },
        });

        let mut steps: Vec<(u64, TurnOp)> = Vec::new();
        let mut at = |ms: u64, op: TurnOp| steps.push((ms, op));
        let ev = TurnOp::Event;
        let ap = TurnOp::Append;

        at(0, ev(serde_json::json!({ "type": "agent_start" })));
        at(
            5,
            ev(
                serde_json::json!({ "type": "message_start", "message": { "role": "user", "content": user_text } }),
            ),
        );
        at(5, ap(user_entry));
        at(
            5,
            ev(
                serde_json::json!({ "type": "message_start", "message": { "role": "assistant", "content": [], "model": model_id } }),
            ),
        );
        at(
            5,
            ev(
                serde_json::json!({ "type": "message_update", "assistantMessageEvent": { "type": "text_start", "contentIndex": 0 } }),
            ),
        );
        for d in deltas {
            at(
                per_delta_ms,
                ev(
                    serde_json::json!({ "type": "message_update", "assistantMessageEvent": { "type": "text_delta", "contentIndex": 0, "delta": d } }),
                ),
            );
        }
        at(
            5,
            ev(
                serde_json::json!({ "type": "message_update", "assistantMessageEvent": { "type": "thinking_start", "contentIndex": 1 } }),
            ),
        );
        at(
            10,
            ev(
                serde_json::json!({ "type": "message_update", "assistantMessageEvent": { "type": "thinking_delta", "contentIndex": 1, "delta": thinking_text } }),
            ),
        );
        at(
            10,
            ev(
                serde_json::json!({ "type": "message_update", "assistantMessageEvent": { "type": "thinking_end", "contentIndex": 1 } }),
            ),
        );
        at(
            5,
            ev(
                serde_json::json!({ "type": "message_update", "assistantMessageEvent": { "type": "toolcall_start", "contentIndex": 2, "id": "t1", "toolName": "read" } }),
            ),
        );
        at(
            10,
            ev(
                serde_json::json!({ "type": "message_update", "assistantMessageEvent": { "type": "toolcall_delta", "contentIndex": 2, "id": "t1", "delta": tool_args_json } }),
            ),
        );
        at(
            10,
            ev(
                serde_json::json!({ "type": "message_update", "assistantMessageEvent": { "type": "toolcall_end", "contentIndex": 2, "id": "t1", "toolCall": { "type": "toolCall", "id": "t1", "name": "read", "arguments": tool_args } } }),
            ),
        );
        at(
            10,
            ev(
                serde_json::json!({ "type": "tool_execution_start", "toolCallId": "t1", "toolName": "read", "args": tool_args }),
            ),
        );
        let partial: String = tool_result_text.chars().take(24).collect();
        at(
            15,
            ev(
                serde_json::json!({ "type": "tool_execution_update", "toolCallId": "t1", "toolName": "read", "args": tool_args, "partialResult": { "content": [{ "type": "text", "text": partial }] } }),
            ),
        );
        at(
            15,
            ev(
                serde_json::json!({ "type": "tool_execution_end", "toolCallId": "t1", "toolName": "read", "result": { "content": [{ "type": "text", "text": tool_result_text }] }, "isError": false }),
            ),
        );
        at(
            10,
            ev(
                serde_json::json!({ "type": "message_end", "message": tool_result_entry["message"] }),
            ),
        );
        at(10, ap(tool_result_entry));
        at(
            10,
            ev(serde_json::json!({ "type": "message_end", "message": assistant_entry["message"] })),
        );
        at(10, ap(assistant_entry));
        steps
    }
}

impl Inner {
    fn stderr_seed(&self) -> Vec<String> {
        vec![
            format!("fake-pi ready ({})", self.id),
            format!("project: {}", self.project),
            format!("read-only: {}", if self.read_only { "on" } else { "off" }),
            format!(
                "general-chat: {}",
                if self.general_chat { "on" } else { "off" }
            ),
        ]
    }
}

#[derive(Debug)]
enum TurnOp {
    Event(serde_json::Value),
    Append(serde_json::Value),
}

/// Split reply prose into streaming deltas: per char (8ms), per word
/// keeping whitespace (40ms, `/\S+\s*/g`-equivalent), or whole (instant).
fn split_deltas(granularity: &Granularity, prompt: &str) -> (Vec<String>, u64) {
    let prose =
        format!("Mock reply to: \"{prompt}\"\n\nThis is a scripted reply. It echoes your prompt.");
    match granularity {
        Granularity::Char => (prose.chars().map(|c| c.to_string()).collect(), 8),
        Granularity::Instant => (vec![prose], 0),
        Granularity::Word => {
            let chars: Vec<char> = prose.chars().collect();
            let mut out = Vec::new();
            let mut i = 0;
            while i < chars.len() {
                while i < chars.len() && chars[i].is_whitespace() {
                    i += 1;
                }
                if i >= chars.len() {
                    break;
                }
                let mut tok = String::new();
                while i < chars.len() && !chars[i].is_whitespace() {
                    tok.push(chars[i]);
                    i += 1;
                }
                while i < chars.len() && chars[i].is_whitespace() {
                    tok.push(chars[i]);
                    i += 1;
                }
                out.push(tok);
            }
            if out.is_empty() {
                out.push(prose);
            }
            (out, 40)
        }
    }
}

/// Test helper: build options with throwaway ids.
#[cfg(test)]
pub fn test_options(id: &str) -> FakePiOptions {
    FakePiOptions {
        id: id.to_string(),
        project: "alpha".to_string(),
        name: Some("test chat".to_string()),
        read_only: false,
        general_chat: false,
        granularity: Granularity::Instant,
        models: vec![ModelInfo::mock_default()],
        history: Vec::new(),
        session_file: PathBuf::from(format!("/tmp/fake-pi-test/{id}.jsonl")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Send one command and read the next stdout line (5s budget).
    async fn round_trip(
        stdin: &mpsc::UnboundedSender<String>,
        stdout: &mut mpsc::UnboundedReceiver<String>,
        cmd: serde_json::Value,
    ) -> serde_json::Value {
        stdin.send(cmd.to_string()).unwrap();
        let line = tokio::time::timeout(std::time::Duration::from_secs(5), stdout.recv())
            .await
            .expect("timed out waiting for fake-pi reply")
            .expect("stdout closed");
        serde_json::from_str(&line).unwrap()
    }

    fn attached(pi: &FakePi) -> AttachedAgent {
        pi.create_attach()
    }

    #[tokio::test]
    async fn get_state_reports_full_shape() {
        let pi = FakePi::new(test_options("t-state"));
        let att = attached(&pi);
        let (stdin, mut stdout) = (att.stdin_tx, att.stdout_rx);
        let resp = round_trip(
            &stdin,
            &mut stdout,
            serde_json::json!({ "id": "1", "type": "get_state" }),
        )
        .await;
        assert_eq!(resp["success"], true);
        assert_eq!(resp["id"], "1");
        assert_eq!(resp["command"], "get_state");
        assert_eq!(resp["data"]["model"]["id"], "mock-sonnet");
        assert_eq!(resp["data"]["thinkingLevel"], "medium");
        assert_eq!(resp["data"]["sessionName"], "test chat");
    }

    #[tokio::test]
    async fn set_model_round_trips_and_sticks() {
        let pi = FakePi::new(test_options("t-model"));
        let att = attached(&pi);
        let (stdin, mut stdout) = (att.stdin_tx, att.stdout_rx);
        let resp = round_trip(
            &stdin,
            &mut stdout,
            serde_json::json!({ "id": "1", "type": "set_model", "provider": "openrouter", "modelId": "mock-haiku" }),
        )
        .await;
        assert_eq!(resp["success"], true);
        assert_eq!(resp["data"]["id"], "mock-haiku");
        let state = round_trip(
            &stdin,
            &mut stdout,
            serde_json::json!({ "id": "2", "type": "get_state" }),
        )
        .await;
        assert_eq!(state["data"]["model"]["id"], "mock-haiku");
        // Missing fields are a 400-style error, not a panic.
        let bad = round_trip(
            &stdin,
            &mut stdout,
            serde_json::json!({ "id": "3", "type": "set_model" }),
        )
        .await;
        assert_eq!(bad["success"], false);
    }

    #[tokio::test]
    async fn state_mutations_stick() {
        let pi = FakePi::new(test_options("t-mut"));
        let att = attached(&pi);
        let (stdin, mut stdout) = (att.stdin_tx, att.stdout_rx);
        for cmd in [
            serde_json::json!({ "id": "1", "type": "set_thinking_level", "level": "high" }),
            serde_json::json!({ "id": "2", "type": "set_session_name", "name": "renamed" }),
        ] {
            assert_eq!(round_trip(&stdin, &mut stdout, cmd).await["success"], true);
        }
        let state = round_trip(
            &stdin,
            &mut stdout,
            serde_json::json!({ "id": "3", "type": "get_state" }),
        )
        .await;
        assert_eq!(state["data"]["thinkingLevel"], "high");
        assert_eq!(state["data"]["sessionName"], "renamed");
        // Catalogs.
        let models = round_trip(
            &stdin,
            &mut stdout,
            serde_json::json!({ "id": "4", "type": "get_available_models" }),
        )
        .await;
        assert_eq!(models["data"]["models"].as_array().unwrap().len(), 1);
        let levels = round_trip(
            &stdin,
            &mut stdout,
            serde_json::json!({ "id": "5", "type": "get_available_thinking_levels" }),
        )
        .await;
        assert_eq!(
            levels["data"]["levels"],
            serde_json::json!(["low", "medium", "high"])
        );
        let stats = round_trip(
            &stdin,
            &mut stdout,
            serde_json::json!({ "id": "6", "type": "get_session_stats" }),
        )
        .await;
        assert_eq!(stats["data"]["contextUsage"]["percent"], 30);
        // Unknown commands error with their name.
        let unknown = round_trip(
            &stdin,
            &mut stdout,
            serde_json::json!({ "id": "7", "type": "frobnicate" }),
        )
        .await;
        assert_eq!(unknown["success"], false);
        assert_eq!(unknown["error"], "unknown command: frobnicate");
    }

    #[tokio::test]
    async fn prompt_streams_turn_then_commits_entries() {
        let pi = FakePi::new(test_options("t-turn"));
        let att = attached(&pi);
        let (stdin, mut stdout) = (att.stdin_tx, att.stdout_rx);
        stdin
            .send(
                serde_json::json!({ "id": "1", "type": "prompt", "message": "hello" }).to_string(),
            )
            .unwrap();
        // Prompt acks first.
        let ack: serde_json::Value = serde_json::from_str(
            &tokio::time::timeout(std::time::Duration::from_secs(5), stdout.recv())
                .await
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(ack["command"], serde_json::json!("prompt"));
        assert_eq!(ack["success"], serde_json::json!(true));
        // Then the turn runs to agent_settled.
        let mut saw_start = false;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let line = tokio::time::timeout(deadline - tokio::time::Instant::now(), stdout.recv())
                .await
                .unwrap()
                .unwrap();
            let ev: serde_json::Value = serde_json::from_str(&line).unwrap();
            if ev.get("type").and_then(|v| v.as_str()) == Some("agent_start") {
                saw_start = true;
            }
            if ev.get("type").and_then(|v| v.as_str()) == Some("agent_settled") {
                break;
            }
        }
        assert!(saw_start);
        // Committed entries backfill with stable ids.
        let entries = round_trip(
            &stdin,
            &mut stdout,
            serde_json::json!({ "id": "2", "type": "get_entries" }),
        )
        .await;
        let list = entries["data"]["entries"].as_array().unwrap();
        assert_eq!(list.len(), 3); // user, toolResult, assistant
        assert_eq!(list[0]["id"], "e1");
        assert_eq!(entries["data"]["leafId"], "e3");
        // Cursor pagination + unknown-cursor error.
        let tail = round_trip(
            &stdin,
            &mut stdout,
            serde_json::json!({ "id": "3", "type": "get_entries", "since": "e1" }),
        )
        .await;
        assert_eq!(tail["data"]["entries"].as_array().unwrap().len(), 2);
        let bad = round_trip(
            &stdin,
            &mut stdout,
            serde_json::json!({ "id": "4", "type": "get_entries", "since": "nope" }),
        )
        .await;
        assert_eq!(bad["success"], serde_json::json!(false));
        assert_eq!(bad["error"], serde_json::json!("unknown cursor"));
    }

    #[tokio::test]
    async fn read_only_slash_toggles_and_notifies() {
        let pi = FakePi::new(test_options("t-ro"));
        let att = attached(&pi);
        let (stdin, mut stdout) = (att.stdin_tx, att.stdout_rx);
        stdin
            .send(
                serde_json::json!({ "id": "1", "type": "prompt", "message": "/read-only on" })
                    .to_string(),
            )
            .unwrap();
        // Ack plus the exact notify text the bridge regexes — in that
        // order, and nothing else (no turn starts for slash commands).
        let mut saw_ack = false;
        let mut saw_notify = false;
        for _ in 0..2 {
            let line = tokio::time::timeout(std::time::Duration::from_secs(5), stdout.recv())
                .await
                .unwrap()
                .unwrap();
            let msg: serde_json::Value = serde_json::from_str(&line).unwrap();
            if msg.get("type").and_then(|v| v.as_str()) == Some("response") {
                saw_ack = true;
            }
            if msg.get("method").and_then(|v| v.as_str()) == Some("notify")
                && msg["message"] == "read-only mode on"
            {
                saw_notify = true;
            }
        }
        assert!(saw_ack && saw_notify);
        // Startup notify fires per attach when read-only is on.
        let att2 = attached(&pi);
        let mut stdout2 = att2.stdout_rx;
        let line = tokio::time::timeout(std::time::Duration::from_secs(5), stdout2.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(line.contains(READ_ONLY_ON_TEXT) || line.contains("read-only"));
    }

    #[tokio::test]
    async fn close_drops_pipes() {
        let pi = FakePi::new(test_options("t-close"));
        let mut att = attached(&pi);
        // stderr carries the seed lines.
        let seed = tokio::time::timeout(std::time::Duration::from_secs(5), att.stderr_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(seed.starts_with("fake-pi ready"));
        pi.close();
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(5), att.stdout_rx.recv())
                .await
                .unwrap()
                .is_none()
        );
        // Attaching after close hands back already-closing pipes.
        let mut att2 = attached(&pi);
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(5), att2.stdout_rx.recv())
                .await
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn resume_loader_reads_entries_and_name() {
        let dir = std::env::temp_dir().join("dashboard-rs-fake-pi-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("resume.jsonl");
        std::fs::write(
            &path,
            serde_json::json!({"type":"session_info","name":"resumed"}).to_string()
                + "\n"
                + &serde_json::json!({"type":"message","id":"m1","message":{"role":"user","content":"hi"}}).to_string()
                + "\nnot json\n",
        )
        .unwrap();
        let (entries, name) = FakePi::load_resume(&path).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(name.as_deref(), Some("resumed"));
        assert!(FakePi::load_resume(&dir.join("missing.jsonl")).is_none());
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn granularity_parsing_and_word_split() {
        assert_eq!(parse_granularity(None), Granularity::Word);
        assert_eq!(parse_granularity(Some("char")), Granularity::Char);
        assert_eq!(parse_granularity(Some("instant")), Granularity::Instant);
        assert_eq!(parse_granularity(Some("bogus")), Granularity::Word);
        let (deltas, ms) = split_deltas(&Granularity::Word, "hi there");
        assert!(deltas.concat().contains("hi there"));
        assert!(ms > 0);
        let (chars, _) = split_deltas(&Granularity::Char, "ab");
        assert!(chars.len() >= 2);
    }
}
