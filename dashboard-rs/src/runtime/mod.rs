//! Runtime seam: every VPS touch-point behind one trait.
//!
//! Port of `dashboard/server/runtime.ts` (+ the `AgentInfo` shape from
//! `dashboard/server/docker.ts`). Production code talks only to [`Runtime`];
//! [`select_runtime`] returns the combined Docker + host-supervisor
//! implementation unless `MOCK_SCENARIO` (or legacy `MOCK_VPS=1`) selects the
//! in-memory [`mock::MockRuntime`] + scripted [`fake_pi::FakePi`] stand-ins
//! (dev only — deploy never sets either variable).
//!
//! Attach streams are line channels, not byte pipes: the bridge (Phase 3)
//! writes JSONL lines to `stdin_tx` and reads demuxed stdout lines plus
//! stderr diagnostics from the receivers. Docker/host backends pump their
//! transports into the same shape, so chat framing never sees the transport.

pub mod docker;
pub mod fake_pi;
pub mod host;
pub mod mock;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::{broadcast, mpsc};

use crate::config::Config;

/// How an agent runs (CONTEXT.md "Runtime"): `jarvis` containers vs
/// bare-metal host pi. Same word the old `AgentInfo.runtime` carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeKind {
    Jarvis,
    Host,
}

impl RuntimeKind {
    /// Wire value used in labels and spawn options (`"jarvis"` / `"host"`).
    pub fn as_str(&self) -> &'static str {
        match self {
            RuntimeKind::Jarvis => "jarvis",
            RuntimeKind::Host => "host",
        }
    }
}

/// Live chat status from the bridge. Phase 2 only ever carries `None` (the
/// bridge owns liveness in Phase 3); the field exists so the row shape
/// already matches `GET /api/agents`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LiveStatus {
    Idle,
    Streaming,
    Exited,
}

/// One agent row (port of `AgentInfo` in `dashboard/server/docker.ts`).
#[derive(Clone, Debug, PartialEq)]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    pub project: String,
    pub origin: Option<String>,
    /// Lowercase daemon state (`running`, `exited`, …) for jarvis agents;
    /// the supervisor state string for host agents.
    pub state: String,
    /// ISO-8601 start time, when known.
    pub started_at: Option<String>,
    pub live: Option<LiveStatus>,
    pub session_name: Option<String>,
    /// General Chat conversation agent (`agent.generalchat` label).
    pub general_chat: bool,
    pub model: Option<String>,
    pub thinking_level: Option<String>,
    pub runtime: RuntimeKind,
    /// Full host directory for host agents; `None` for jarvis containers.
    pub directory: Option<String>,
}

/// Spawn parameters (port of `SpawnOptions` in `runtime.ts`).
/// `project` is the resolved host dir — the same value the start route
/// passes to jarvis today, and the `cwd` for host spawns.
#[derive(Clone, Debug)]
pub struct SpawnOptions {
    pub project: PathBuf,
    pub session_path: Option<PathBuf>,
    pub name: Option<String>,
    pub read_only: bool,
    pub general_chat: bool,
    pub runtime: RuntimeKind,
}

impl SpawnOptions {
    /// Plain jarvis spawn on a resolved project dir.
    pub fn jarvis(project: PathBuf) -> Self {
        Self {
            project,
            session_path: None,
            name: None,
            read_only: false,
            general_chat: false,
            runtime: RuntimeKind::Jarvis,
        }
    }
}

/// Open stdio to one agent's `pi --mode rpc` process: bridge writes JSONL
/// lines to `stdin_tx`; demuxed stdout lines and stderr diagnostics arrive
/// on the receivers. Dropping the senders (or the agent going away) closes
/// the receivers — the bridge's exited path.
#[derive(Debug)]
pub struct AttachedAgent {
    pub stdin_tx: mpsc::UnboundedSender<String>,
    pub stdout_rx: mpsc::UnboundedReceiver<String>,
    pub stderr_rx: mpsc::UnboundedReceiver<String>,
}

/// Container lifecycle transition (port of `LifecycleEvent`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LifecycleAction {
    Start,
    Die,
    Destroy,
    Rename,
}

impl LifecycleAction {
    pub fn as_str(&self) -> &'static str {
        match self {
            LifecycleAction::Start => "start",
            LifecycleAction::Die => "die",
            LifecycleAction::Destroy => "destroy",
            LifecycleAction::Rename => "rename",
        }
    }
}

/// A lifecycle transition for one agent id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LifecycleEvent {
    pub action: LifecycleAction,
    pub id: String,
}

/// Every VPS touch-point the dashboard needs. Static dispatch on purpose:
/// `CombinedRuntime<D, H>` merges two backends without a `dyn` boundary or
/// an `async-trait` crate. Methods return `impl Future + Send` (not naked
/// `async fn` — the futures stay `Send` for Axum handlers, and the trait
/// stays warning-free under the `async_fn_in_trait` lint); implementations
/// keep writing plain `async fn`.
pub trait Runtime: Send + Sync + 'static {
    /// → `GET /api/agents`. Sorted by project, then name.
    fn list(&self) -> impl Future<Output = Result<Vec<AgentInfo>, RuntimeError>> + Send;
    /// → chat guard. `Ok(None)` when the id is unknown (or gone).
    fn labels(
        &self,
        id: &str,
    ) -> impl Future<Output = Result<Option<HashMap<String, String>>, RuntimeError>> + Send;
    /// → bridge stdio.
    fn attach(&self, id: &str) -> impl Future<Output = Result<AttachedAgent, RuntimeError>> + Send;
    /// → terminate route. Idempotent: stopping a gone agent succeeds.
    fn stop_and_remove(&self, id: &str) -> impl Future<Output = Result<(), RuntimeError>> + Send;
    /// → start route. Returns the new agent id.
    fn spawn(
        &self,
        opts: SpawnOptions,
    ) -> impl Future<Output = Result<String, RuntimeError>> + Send;
    /// → global agent feed. Each receiver sees every later transition;
    /// lagged receivers skip (a refetch is the resync path, as before).
    fn subscribe(&self) -> broadcast::Receiver<LifecycleEvent>;
}

/// Production runtime: Docker (jarvis) + host supervisor merged behind one
/// seam (port of `CombinedRuntime`). Id routing follows the old rule —
/// `host-` prefixed ids go to the supervisor, everything else to Docker.
/// A failing backend degrades to an empty half-list, never a failed list.
pub struct CombinedRuntime<D: Runtime, H: Runtime> {
    docker: D,
    host: H,
    lifecycle_tx: broadcast::Sender<LifecycleEvent>,
}

impl<D: Runtime, H: Runtime> CombinedRuntime<D, H> {
    pub fn new(docker: D, host: H) -> Self {
        let (lifecycle_tx, _) = broadcast::channel(256);
        let this = Self {
            docker,
            host,
            lifecycle_tx,
        };
        this.spawn_forwarders();
        this
    }

    fn spawn_forwarders(&self) {
        for mut rx in [self.docker.subscribe(), self.host.subscribe()] {
            let tx = self.lifecycle_tx.clone();
            tokio::spawn(async move {
                while let Ok(ev) = rx.recv().await {
                    let _ = tx.send(ev);
                }
            });
        }
    }
}

impl<D: Runtime, H: Runtime> Runtime for CombinedRuntime<D, H> {
    async fn list(&self) -> Result<Vec<AgentInfo>, RuntimeError> {
        let (docker_agents, host_agents) = tokio::join!(self.docker.list(), self.host.list());
        let mut out = match docker_agents {
            Ok(agents) => agents,
            Err(err) => {
                log::error!("[runtime] docker list failed: {err}");
                Vec::new()
            }
        };
        out.extend(host_agents.unwrap_or_default());
        sort_agents(&mut out);
        Ok(out)
    }

    async fn labels(&self, id: &str) -> Result<Option<HashMap<String, String>>, RuntimeError> {
        if host::is_host_id(id) {
            self.host.labels(id).await
        } else {
            self.docker.labels(id).await
        }
    }

    async fn attach(&self, id: &str) -> Result<AttachedAgent, RuntimeError> {
        if host::is_host_id(id) {
            self.host.attach(id).await
        } else {
            self.docker.attach(id).await
        }
    }

    async fn stop_and_remove(&self, id: &str) -> Result<(), RuntimeError> {
        if host::is_host_id(id) {
            self.host.stop_and_remove(id).await
        } else {
            self.docker.stop_and_remove(id).await
        }
    }

    async fn spawn(&self, opts: SpawnOptions) -> Result<String, RuntimeError> {
        if opts.runtime == RuntimeKind::Host {
            self.host.spawn(opts).await
        } else {
            self.docker.spawn(opts).await
        }
    }

    fn subscribe(&self) -> broadcast::Receiver<LifecycleEvent> {
        self.lifecycle_tx.subscribe()
    }
}

/// Sort agent rows the way both old list paths did: project, then name.
pub fn sort_agents(agents: &mut [AgentInfo]) {
    agents.sort_by(|a, b| a.project.cmp(&b.project).then_with(|| a.name.cmp(&b.name)));
}

/// Append demuxed bytes to a line buffer, forwarding complete lines.
/// Shared by the Docker and host attach pumps.
pub(crate) fn push_lines(tx: &mpsc::UnboundedSender<String>, buf: &mut String, chunk: &[u8]) {
    buf.push_str(&String::from_utf8_lossy(chunk));
    while let Some(idx) = buf.find('\n') {
        let mut line: String = buf.drain(..=idx).collect();
        while line.ends_with('\n') || line.ends_with('\r') {
            line.pop();
        }
        if tx.send(line).is_err() {
            break;
        }
    }
}

/// A final partial line (stream ended mid-frame) is still a real line.
pub(crate) fn flush_line(tx: &mpsc::UnboundedSender<String>, buf: &mut String) {
    if !buf.is_empty() {
        let remainder = std::mem::take(buf);
        let _ = tx.send(remainder);
    }
}

/// Errors from any runtime backend.
#[derive(Debug, thiserror::Error)]
pub enum RuntimeError {
    #[error("docker: {0}")]
    Docker(String),
    #[error("host supervisor: {0}")]
    Host(String),
    #[error("spawn failed: {0}")]
    Spawn(String),
    #[error("unknown agent: {0}")]
    UnknownAgent(String),
    #[error("{0}")]
    Scenario(String),
}

/// The wired runtime: prod (Docker + supervisor) or mock (dev only).
pub enum SelectedRuntime {
    Prod(CombinedRuntime<docker::DockerRuntime, host::HostRuntime>),
    Mock(Arc<mock::MockRuntime>),
}

impl SelectedRuntime {
    /// One-line boot log: which backend, and which mock scenario.
    pub fn describe(&self) -> String {
        match self {
            SelectedRuntime::Prod(_) => "prod (docker + host supervisor)".to_string(),
            SelectedRuntime::Mock(_) => format!(
                "mock (scenario={})",
                mock::requested_scenario().unwrap_or_else(|| "sidebar-full".to_string())
            ),
        }
    }
}

/// Wire the runtime from the environment. Mock mode is `MOCK_SCENARIO=name`
/// (or legacy `MOCK_VPS=1`, defaulting to `sidebar-full`); anything else is
/// prod. Unknown scenario names fail fast with the valid list — same rule
/// the old `MockRuntime` seed enforced.
pub fn select_runtime(config: &Config) -> Result<SelectedRuntime, RuntimeError> {
    if mock::mock_requested() {
        let scenario = mock::requested_scenario().unwrap_or_else(|| "sidebar-full".to_string());
        let mock = mock::MockRuntime::from_scenario(&scenario, &config.sessions_dir)?;
        return Ok(SelectedRuntime::Mock(Arc::new(mock)));
    }
    Ok(SelectedRuntime::Prod(CombinedRuntime::new(
        docker::DockerRuntime::new(config.jarvis_bin.clone()),
        host::HostRuntime::new(config.host_supervisor_sock.clone()),
    )))
}

#[cfg(test)]
mod tests {
    use super::mock::MockRuntime;
    use super::*;

    fn prod() -> CombinedRuntime<MockRuntime, MockRuntime> {
        let dir = PathBuf::from("/tmp/dashboard-rs-runtime-test");
        CombinedRuntime::new(
            MockRuntime::from_scenario("sidebar-full", &dir).unwrap(),
            MockRuntime::from_scenario("empty", &dir).unwrap(),
        )
    }

    #[tokio::test]
    async fn combined_list_merges_and_sorts() {
        let rt = prod();
        let agents = rt.list().await.unwrap();
        assert_eq!(agents.len(), 3);
        let projects: Vec<_> = agents.iter().map(|a| a.project.as_str()).collect();
        assert_eq!(projects, ["alpha", "alpha", "beta"]);
    }

    #[tokio::test]
    async fn combined_spawn_routes_by_runtime_kind() {
        let rt = prod();
        let jarvis = rt
            .spawn(SpawnOptions::jarvis(PathBuf::from(
                "/home/dev/projects/alpha",
            )))
            .await
            .unwrap();
        assert!(jarvis.starts_with("mock-"));
        let host = rt
            .spawn(SpawnOptions {
                project: PathBuf::from("/home/dev/notes"),
                runtime: RuntimeKind::Host,
                ..SpawnOptions::jarvis(PathBuf::from("/home/dev/notes"))
            })
            .await
            .unwrap();
        assert!(host.starts_with("host-mock-"));
    }

    #[tokio::test]
    async fn combined_lifecycle_fans_out_to_one_feed() {
        let rt = prod();
        let mut rx = rt.subscribe();
        let id = rt
            .spawn(SpawnOptions::jarvis(PathBuf::from(
                "/home/dev/projects/alpha",
            )))
            .await
            .unwrap();
        assert_eq!(
            rx.recv().await.unwrap(),
            LifecycleEvent {
                action: LifecycleAction::Start,
                id: id.clone(),
            }
        );
        rt.stop_and_remove(&id).await.unwrap();
        assert_eq!(
            rx.recv().await.unwrap(),
            LifecycleEvent {
                action: LifecycleAction::Die,
                id: id.clone(),
            }
        );
        assert_eq!(
            rx.recv().await.unwrap(),
            LifecycleEvent {
                action: LifecycleAction::Destroy,
                id,
            }
        );
    }

    #[test]
    fn sort_agents_orders_project_then_name() {
        let row = |project: &str, name: &str| AgentInfo {
            id: name.to_string(),
            name: name.to_string(),
            project: project.to_string(),
            origin: None,
            state: "running".to_string(),
            started_at: None,
            live: None,
            session_name: None,
            general_chat: false,
            model: None,
            thinking_level: None,
            runtime: RuntimeKind::Jarvis,
            directory: None,
        };
        let mut agents = vec![row("beta", "b"), row("alpha", "z"), row("alpha", "a")];
        sort_agents(&mut agents);
        let order: Vec<_> = agents.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(order, ["a", "z", "b"]);
    }
}
