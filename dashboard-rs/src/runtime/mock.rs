//! MockRuntime — in-memory [`Runtime`](super::Runtime) for mock mode.
//!
//! Port of `dashboard/server/mock/runtime.ts`: no Docker, no jarvis, no host
//! mounts. Agents live in a `HashMap`, each owning a [`FakePi`](super::fake_pi::FakePi)
//! session. Seeding is hardcoded (not a generated JSON file — fixtures are
//! compiled in, so `cargo test` is hermetic): [`SCENARIO_NAMES`] mirrors the
//! old `MOCK_SCENARIO` table, `MOCK_SCENARIO=name` selects, and unknown names
//! fail fast with the valid list.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tokio::sync::broadcast;

use super::fake_pi::{self, FakePi, FakePiOptions, Granularity, ModelInfo};
use super::{
    AgentInfo, AttachedAgent, LifecycleAction, LifecycleEvent, Runtime, RuntimeError, RuntimeKind,
    SpawnOptions, sort_agents,
};

/// The five mock scenarios (old `MOCK_SCENARIO` table in `docs/testing.md`).
pub const SCENARIO_NAMES: &[&str] = &[
    "sidebar-full",
    "chat-streaming",
    "notes-editor",
    "gc-chat",
    "empty",
];

/// Sorted valid scenario list, for fail-fast errors.
pub fn valid_scenarios() -> String {
    let mut names: Vec<_> = SCENARIO_NAMES.to_vec();
    names.sort();
    names.join(", ")
}

/// True when the mock backend is requested: `MOCK_SCENARIO` set (non-blank)
/// or legacy `MOCK_VPS=1`. Dev only — deploy sets neither.
pub fn mock_requested() -> bool {
    std::env::var("MOCK_SCENARIO")
        .ok()
        .is_some_and(|v| !v.trim().is_empty())
        || std::env::var("MOCK_VPS").ok().as_deref() == Some("1")
}

/// The requested scenario name, if set and non-blank.
pub fn requested_scenario() -> Option<String> {
    std::env::var("MOCK_SCENARIO")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Per-agent granularity override for spawns (`MOCK_GRANULARITY=char|word|instant`).
fn spawn_granularity() -> Granularity {
    fake_pi::parse_granularity(std::env::var("MOCK_GRANULARITY").ok().as_deref())
}

fn user_entry(id: &str, text: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "message",
        "id": id,
        "message": { "role": "user", "content": text },
    })
}

fn assistant_entry(id: &str, text: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "message",
        "id": id,
        "message": {
            "role": "assistant",
            "content": [{ "type": "text", "text": text }],
        },
    })
}

struct SeedConfig {
    project: &'static str,
    name: &'static str,
    origin: Option<&'static str>,
    read_only: bool,
    general_chat: bool,
    granularity: Granularity,
    history: Vec<serde_json::Value>,
}

/// Hardcoded scenarios. Seeds mirror `testdata/mock/scenarios.json`
/// (same projects, names, read-only flags, GC flag, history ids).
fn scenario_seeds(name: &str) -> Option<Vec<SeedConfig>> {
    match name {
        "sidebar-full" => Some(vec![
            SeedConfig {
                project: "alpha",
                name: "alpha chat",
                origin: Some("dashboard"),
                read_only: false,
                general_chat: false,
                granularity: Granularity::Word,
                history: vec![
                    user_entry("hist-s1", "What is this project?"),
                    assistant_entry(
                        "hist-s2",
                        "This is the mock Alpha project for offline dashboard testing.",
                    ),
                ],
            },
            SeedConfig {
                project: "alpha",
                name: "alpha side quest",
                origin: None,
                read_only: true,
                general_chat: false,
                granularity: Granularity::Word,
                history: Vec::new(),
            },
            SeedConfig {
                project: "beta",
                name: "beta chat",
                origin: Some("dashboard"),
                read_only: false,
                general_chat: false,
                granularity: Granularity::Word,
                history: Vec::new(),
            },
        ]),
        "chat-streaming" => Some(vec![SeedConfig {
            project: "alpha",
            name: "stream test",
            origin: Some("dashboard"),
            read_only: false,
            general_chat: false,
            granularity: Granularity::Char,
            history: vec![
                user_entry("hist-c1", "Hello, stream test"),
                assistant_entry(
                    "hist-c2",
                    "History is preloaded — new prompts stream char by char.",
                ),
            ],
        }]),
        "notes-editor" => Some(vec![SeedConfig {
            project: "notes",
            name: "notes chat",
            origin: Some("dashboard"),
            read_only: false,
            general_chat: false,
            granularity: Granularity::Word,
            history: Vec::new(),
        }]),
        "gc-chat" => Some(vec![SeedConfig {
            project: "notes",
            name: "gc chat",
            origin: Some("dashboard"),
            read_only: true,
            general_chat: true,
            granularity: Granularity::Word,
            history: vec![
                user_entry("hist-g1", "What is in my notes?"),
                assistant_entry(
                    "hist-g2",
                    "Welcome, ideas, and todo — this is the mock notes vault.",
                ),
            ],
        }]),
        "empty" => Some(Vec::new()),
        _ => None,
    }
}

fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

#[derive(Debug)]
struct MockAgent {
    project: String,
    dir: PathBuf,
    origin: Option<String>,
    general_chat: bool,
    state: String,
    started_at: String,
    runtime: RuntimeKind,
    pi: FakePi,
}

#[derive(Debug)]
struct MockInner {
    agents: HashMap<String, MockAgent>,
    seq: u64,
}

/// In-memory runtime. One instance is wired at boot and held for the
/// process lifetime.
#[derive(Debug)]
pub struct MockRuntime {
    inner: Mutex<MockInner>,
    lifecycle_tx: broadcast::Sender<LifecycleEvent>,
    sessions_dir: PathBuf,
}

impl MockRuntime {
    /// Seed from an explicit scenario name. Unknown names fail fast with
    /// the valid list (same rule as the old seed loader).
    pub fn from_scenario(name: &str, sessions_dir: &Path) -> Result<Self, RuntimeError> {
        let Some(seeds) = scenario_seeds(name) else {
            return Err(RuntimeError::Scenario(format!(
                "unknown MOCK_SCENARIO={name:?} (valid: {})",
                valid_scenarios()
            )));
        };
        let (lifecycle_tx, _) = broadcast::channel(256);
        let this = Self {
            inner: Mutex::new(MockInner {
                agents: HashMap::new(),
                seq: 0,
            }),
            lifecycle_tx,
            sessions_dir: sessions_dir.to_path_buf(),
        };
        for seed in seeds {
            this.add_seeded(seed);
        }
        Ok(this)
    }

    /// Seed from `MOCK_SCENARIO` (default `sidebar-full`).
    pub fn from_env(sessions_dir: &Path) -> Result<Self, RuntimeError> {
        let name = requested_scenario().unwrap_or_else(|| "sidebar-full".to_string());
        Self::from_scenario(&name, sessions_dir)
    }

    fn session_file(&self, id: &str) -> PathBuf {
        self.sessions_dir.join("mock").join(format!("{id}.jsonl"))
    }

    fn emit(&self, action: LifecycleAction, id: &str) {
        let _ = self.lifecycle_tx.send(LifecycleEvent {
            action,
            id: id.to_string(),
        });
    }

    fn add_seeded(&self, seed: SeedConfig) {
        let mut inner = self.inner.lock().unwrap();
        inner.seq += 1;
        let id = format!("mock-{}", inner.seq);
        let pi = FakePi::new(FakePiOptions {
            id: id.clone(),
            project: seed.project.to_string(),
            name: Some(seed.name.to_string()),
            read_only: seed.read_only,
            general_chat: seed.general_chat,
            granularity: seed.granularity,
            models: ModelInfo::mock_catalog(),
            history: seed.history,
            session_file: self.session_file(&id),
        });
        inner.agents.insert(
            id.clone(),
            MockAgent {
                project: seed.project.to_string(),
                dir: PathBuf::from(seed.project),
                origin: seed.origin.map(str::to_string),
                general_chat: seed.general_chat,
                state: "running".to_string(),
                started_at: now_iso(),
                runtime: RuntimeKind::Jarvis,
                pi,
            },
        );
    }

    fn project_name(project_dir: &Path) -> String {
        project_dir
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "unknown".to_string())
    }
}

impl Runtime for MockRuntime {
    async fn list(&self) -> Result<Vec<AgentInfo>, RuntimeError> {
        let inner = self.inner.lock().unwrap();
        let mut out: Vec<AgentInfo> = inner
            .agents
            .iter()
            .map(|(id, a)| AgentInfo {
                id: id.clone(),
                name: id.clone(),
                project: a.project.clone(),
                origin: a.origin.clone(),
                state: a.state.clone(),
                started_at: Some(a.started_at.clone()),
                live: None,
                session_name: None,
                general_chat: a.general_chat,
                model: None,
                thinking_level: None,
                runtime: a.runtime,
                directory: if a.runtime == RuntimeKind::Host {
                    Some(a.dir.to_string_lossy().into_owned())
                } else {
                    None
                },
            })
            .collect();
        sort_agents(&mut out);
        Ok(out)
    }

    async fn labels(&self, id: &str) -> Result<Option<HashMap<String, String>>, RuntimeError> {
        let inner = self.inner.lock().unwrap();
        let Some(a) = inner.agents.get(id) else {
            return Ok(None);
        };
        let mut labels = HashMap::new();
        labels.insert("agent.kind".to_string(), "pi".to_string());
        labels.insert("agent.project".to_string(), a.project.clone());
        if let Some(origin) = &a.origin {
            labels.insert("agent.origin".to_string(), origin.clone());
        }
        if a.general_chat {
            labels.insert("agent.generalchat".to_string(), "true".to_string());
        }
        if a.runtime == RuntimeKind::Host {
            labels.insert("agent.runtime".to_string(), "host".to_string());
            labels.insert(
                "agent.directory".to_string(),
                a.dir.to_string_lossy().into_owned(),
            );
        }
        Ok(Some(labels))
    }

    async fn attach(&self, id: &str) -> Result<AttachedAgent, RuntimeError> {
        let pi = {
            let inner = self.inner.lock().unwrap();
            inner.agents.get(id).map(|a| a.pi.clone())
        };
        match pi {
            Some(pi) => Ok(pi.create_attach()),
            None => Err(RuntimeError::UnknownAgent(id.to_string())),
        }
    }

    async fn stop_and_remove(&self, id: &str) -> Result<(), RuntimeError> {
        let pi = {
            let mut inner = self.inner.lock().unwrap();
            inner.agents.remove(id).map(|a| a.pi)
        };
        // Close pipes first: drives the bridge's exited path exactly like a
        // real stop. Delete before emitting so a client refetching on
        // agents_changed never sees the ghost.
        if let Some(pi) = pi {
            pi.close();
            self.emit(LifecycleAction::Die, id);
            self.emit(LifecycleAction::Destroy, id);
        }
        Ok(())
    }

    async fn spawn(&self, opts: SpawnOptions) -> Result<String, RuntimeError> {
        let mut inner = self.inner.lock().unwrap();
        inner.seq += 1;
        let host = opts.runtime == RuntimeKind::Host;
        let id = if host {
            format!("host-mock-{}", inner.seq)
        } else {
            format!("mock-{}", inner.seq)
        };
        let project = Self::project_name(&opts.project);
        let (history, resume_name) = match &opts.session_path {
            Some(path) => FakePi::load_resume(path).unwrap_or_default(),
            None => (Vec::new(), None),
        };
        // No placeholder name: fresh spawns stay untitled until the first
        // message titles them. Resumes keep their session name.
        let name = opts.name.clone().or(resume_name);
        let pi = FakePi::new(FakePiOptions {
            id: id.clone(),
            project: project.clone(),
            name,
            read_only: opts.read_only,
            general_chat: opts.general_chat,
            granularity: spawn_granularity(),
            models: ModelInfo::mock_catalog(),
            history,
            session_file: self.session_file(&id),
        });
        inner.agents.insert(
            id.clone(),
            MockAgent {
                project,
                dir: opts.project.clone(),
                origin: Some("dashboard".to_string()),
                general_chat: opts.general_chat,
                state: "running".to_string(),
                started_at: now_iso(),
                runtime: if host {
                    RuntimeKind::Host
                } else {
                    RuntimeKind::Jarvis
                },
                pi,
            },
        );
        drop(inner);
        self.emit(LifecycleAction::Start, &id);
        Ok(id)
    }

    fn subscribe(&self) -> broadcast::Receiver<LifecycleEvent> {
        self.lifecycle_tx.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir() -> PathBuf {
        PathBuf::from("/tmp/dashboard-rs-mock-test")
    }

    #[test]
    fn five_scenarios_by_name() {
        assert_eq!(SCENARIO_NAMES.len(), 5);
        for name in SCENARIO_NAMES {
            MockRuntime::from_scenario(name, &test_dir()).unwrap();
        }
    }

    #[test]
    fn unknown_scenario_fails_fast_with_valid_list() {
        let err = MockRuntime::from_scenario("nope", &test_dir()).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("unknown MOCK_SCENARIO"), "{msg}");
        for name in SCENARIO_NAMES {
            assert!(msg.contains(name), "{msg}");
        }
    }

    #[tokio::test]
    async fn sidebar_full_seeds_three_agents_two_projects() {
        let rt = MockRuntime::from_scenario("sidebar-full", &test_dir()).unwrap();
        let agents = rt.list().await.unwrap();
        assert_eq!(agents.len(), 3);
        let projects: Vec<_> = agents.iter().map(|a| a.project.as_str()).collect();
        assert_eq!(projects, ["alpha", "alpha", "beta"]);
        assert!(agents.iter().all(|a| a.state == "running"));
        assert!(agents.iter().all(|a| a.runtime == RuntimeKind::Jarvis));
    }

    #[tokio::test]
    async fn seeded_history_backfills() {
        let rt = MockRuntime::from_scenario("chat-streaming", &test_dir()).unwrap();
        let agents = rt.list().await.unwrap();
        assert_eq!(agents.len(), 1);
        let mut att = rt.attach(&agents[0].id).await.unwrap();
        att.stdin_tx
            .send(serde_json::json!({ "id": "1", "type": "get_entries" }).to_string())
            .unwrap();
        let line = tokio::time::timeout(std::time::Duration::from_secs(5), att.stdout_rx.recv())
            .await
            .expect("timed out waiting for entries")
            .expect("stdout closed");
        let resp: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(resp["data"]["entries"].as_array().unwrap().len(), 2);
        assert_eq!(resp["data"]["leafId"], "hist-c2");
    }

    #[tokio::test]
    async fn spawn_stop_lifecycle_round_trip() {
        let rt = MockRuntime::from_scenario("empty", &test_dir()).unwrap();
        let mut rx = rt.subscribe();
        let id = rt
            .spawn(SpawnOptions::jarvis(PathBuf::from(
                "/home/dev/projects/alpha",
            )))
            .await
            .unwrap();
        assert!(id.starts_with("mock-"));
        assert_eq!(rx.recv().await.unwrap().action, LifecycleAction::Start);
        // Fresh spawns are untitled; resumes keep their session name.
        let labels = rt.labels(&id).await.unwrap().unwrap();
        assert_eq!(labels["agent.kind"], "pi");
        assert_eq!(labels["agent.project"], "alpha");
        assert_eq!(labels["agent.origin"], "dashboard");
        rt.stop_and_remove(&id).await.unwrap();
        assert_eq!(rx.recv().await.unwrap().action, LifecycleAction::Die);
        assert_eq!(rx.recv().await.unwrap().action, LifecycleAction::Destroy);
        assert!(rt.list().await.unwrap().is_empty());
        // Idempotent stop + unknown attach error.
        rt.stop_and_remove(&id).await.unwrap();
        assert!(matches!(
            rt.attach(&id).await,
            Err(RuntimeError::UnknownAgent(_))
        ));
        assert!(rt.labels(&id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn host_spawn_carries_runtime_and_directory() {
        let rt = MockRuntime::from_scenario("empty", &test_dir()).unwrap();
        let id = rt
            .spawn(SpawnOptions {
                project: PathBuf::from("/home/dev/notes"),
                runtime: RuntimeKind::Host,
                ..SpawnOptions::jarvis(PathBuf::from("/home/dev/notes"))
            })
            .await
            .unwrap();
        assert!(id.starts_with("host-mock-"));
        let agents = rt.list().await.unwrap();
        assert_eq!(agents[0].runtime, RuntimeKind::Host);
        assert_eq!(agents[0].directory.as_deref(), Some("/home/dev/notes"));
        let labels = rt.labels(&id).await.unwrap().unwrap();
        assert_eq!(labels["agent.runtime"], "host");
        assert_eq!(labels["agent.directory"], "/home/dev/notes");
    }

    #[tokio::test]
    async fn resume_spawn_keeps_session_name() {
        let dir = std::env::temp_dir().join("dashboard-rs-mock-resume-test");
        std::fs::create_dir_all(&dir).unwrap();
        let session = dir.join("sess.jsonl");
        std::fs::write(
            &session,
            serde_json::json!({"type":"session_info","name":"resumed chat"}).to_string()
                + "\n"
                + &serde_json::json!({"type":"message","id":"m1","message":{"role":"user","content":"hi"}})
                    .to_string()
                + "\n",
        )
        .unwrap();
        let rt = MockRuntime::from_scenario("empty", &test_dir()).unwrap();
        let id = rt
            .spawn(SpawnOptions {
                project: PathBuf::from("/home/dev/projects/alpha"),
                session_path: Some(session.clone()),
                ..SpawnOptions::jarvis(PathBuf::from("/home/dev/projects/alpha"))
            })
            .await
            .unwrap();
        let att = rt.attach(&id).await.unwrap();
        att.stdin_tx
            .send(serde_json::json!({ "id": "1", "type": "get_state" }).to_string())
            .unwrap();
        let mut stdout = att.stdout_rx;
        let line = tokio::time::timeout(std::time::Duration::from_secs(5), stdout.recv())
            .await
            .unwrap()
            .unwrap();
        let state: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(state["data"]["sessionName"], "resumed chat");
        std::fs::remove_file(&session).unwrap();
    }
}
