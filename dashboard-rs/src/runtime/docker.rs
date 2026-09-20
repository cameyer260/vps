//! DockerRuntime — production jarvis-container backend.
//!
//! Port of `dashboard/server/runtime-docker.ts` (+ `docker.ts` + `jarvis.ts`
//! bodies it delegates to). The dashboard never builds `docker run`
//! statements itself: spawns shell out to `jarvis rpc` (the single source of
//! truth, `docs/jarvis.md`); everything else goes through the Docker API via
//! bollard. Attach and event streams are pumped into the seam's line
//! channels so the bridge never sees the transport.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use bollard::errors::Error as BollardError;
use bollard::query_parameters::{
    AttachContainerOptionsBuilder, EventsOptionsBuilder, ListContainersOptionsBuilder,
    RemoveContainerOptionsBuilder, StopContainerOptionsBuilder,
};
use bollard::{API_DEFAULT_VERSION, Docker};
use futures_util::StreamExt as _;
use tokio::io::AsyncWriteExt as _;
use tokio::sync::{broadcast, mpsc};

use super::{
    AgentInfo, AttachedAgent, LifecycleAction, LifecycleEvent, Runtime, RuntimeError, RuntimeKind,
    SpawnOptions, flush_line, push_lines, sort_agents,
};

/// General Chat system prompt, appended server-side via `jarvis rpc`'s
/// `--append-system-prompt` passthrough (port of `server/general-chat.ts`;
/// never leaves the server).
const GENERAL_CHAT_SYSTEM_PROMPT: &str = "You are General Chat, a friendly general-purpose chatbot running inside the operator's dashboard.\nYou chat about anything, over the operator's notes directory as your working context.\n\nWeb lookup behavior:\n- For fresh, external, or factual questions (news, docs, prices, versions, people, places, anything that may have changed since training), use the bx web-search skill instead of answering from weights.\n- Run the searches automatically first, then answer with what you found — do not ask permission to search and do not narrate a multi-step agent plan.\n- Prefer a short acknowledgement followed by the researched answer.\n\nTone: chat-first, concise, conversational — like ChatGPT/Grok. Short answers by default; expand only when asked.\nDo not act like a coding agent (no task plans, no file-write proposals) unless the user explicitly asks for agent-style work.";

/// Lifecycle actions the agent feed cares about (old `WATCHED` set).
const WATCHED: &[&str] = &["start", "die", "destroy", "rename"];

/// Docker-backed [`Runtime`]. Construction never touches the socket — every
/// call connects fresh, so a daemon restart is just the next call working.
pub struct DockerRuntime {
    jarvis_bin: PathBuf,
    lifecycle_tx: broadcast::Sender<LifecycleEvent>,
}

impl DockerRuntime {
    pub fn new(jarvis_bin: PathBuf) -> Self {
        let (lifecycle_tx, _) = broadcast::channel(256);
        let this = Self {
            jarvis_bin,
            lifecycle_tx,
        };
        this.spawn_event_task();
        this
    }

    /// Connect to the daemon, honoring `DOCKER_SOCKET` like the old
    /// `docker.ts` (bollard's own default only reads `DOCKER_HOST`).
    /// `sock_override` is the test seam — production passes `None`.
    fn connect_for(sock_override: Option<&str>) -> Result<Docker, RuntimeError> {
        let sock = sock_override.map(str::to_string).or_else(|| {
            std::env::var("DOCKER_SOCKET")
                .ok()
                .filter(|s| !s.trim().is_empty())
        });
        match sock {
            Some(path) => Docker::connect_with_socket(&path, 120, API_DEFAULT_VERSION)
                .map_err(|e| RuntimeError::Docker(e.to_string())),
            None => Docker::connect_with_socket_defaults()
                .map_err(|e| RuntimeError::Docker(e.to_string())),
        }
    }

    fn connect() -> Result<Docker, RuntimeError> {
        Self::connect_for(None)
    }

    fn spawn_event_task(&self) {
        let tx = self.lifecycle_tx.clone();
        tokio::spawn(async move {
            loop {
                Self::pump_events(&tx).await;
                // Daemon restarted or the stream broke — pause, then resubscribe.
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        });
    }

    async fn pump_events(tx: &broadcast::Sender<LifecycleEvent>) {
        let docker = match Self::connect() {
            Ok(d) => d,
            Err(_) => return,
        };
        let mut filters = HashMap::new();
        filters.insert("type".to_string(), vec!["container".to_string()]);
        filters.insert(
            "event".to_string(),
            WATCHED.iter().map(|s| s.to_string()).collect(),
        );
        filters.insert("label".to_string(), vec!["agent.kind=pi".to_string()]);
        let options = EventsOptionsBuilder::new().filters(&filters).build();
        let mut stream = Box::pin(docker.events(Some(options)));
        while let Some(item) = stream.next().await {
            let Ok(ev) = item else { return };
            let action = match ev.action.as_deref() {
                Some("start") => LifecycleAction::Start,
                Some("die") => LifecycleAction::Die,
                Some("destroy") => LifecycleAction::Destroy,
                Some("rename") => LifecycleAction::Rename,
                _ => continue,
            };
            let id = ev.actor.and_then(|a| a.id).unwrap_or_default();
            if id.is_empty() {
                continue;
            }
            let _ = tx.send(LifecycleEvent { action, id });
        }
    }
}

fn docker_err(e: BollardError) -> RuntimeError {
    RuntimeError::Docker(e.to_string())
}

/// True for the daemon's "already gone / already going" statuses, which all
/// converge on success for stop/remove (matches the old status-code checks).
fn is_gone_status(e: &BollardError, codes: &[u16]) -> bool {
    matches!(e, BollardError::DockerResponseServerError { status_code, .. } if codes.contains(status_code))
}

fn unknown_agent(id: &str, e: BollardError) -> RuntimeError {
    if is_gone_status(&e, &[404]) {
        RuntimeError::UnknownAgent(id.to_string())
    } else {
        docker_err(e)
    }
}

impl Runtime for DockerRuntime {
    async fn list(&self) -> Result<Vec<AgentInfo>, RuntimeError> {
        let docker = Self::connect()?;
        let mut filters = HashMap::new();
        filters.insert("label".to_string(), vec!["agent.kind=pi".to_string()]);
        let options = ListContainersOptionsBuilder::new()
            .all(true)
            .filters(&filters)
            .build();
        let summaries = docker
            .list_containers(Some(options))
            .await
            .map_err(docker_err)?;
        let mut agents = Vec::with_capacity(summaries.len());
        for s in summaries {
            let Some(id) = s.id else { continue };
            let labels = s.labels.unwrap_or_default();
            let name = s
                .names
                .and_then(|names| names.into_iter().next())
                .map(|n| n.trim_start_matches('/').to_string())
                .unwrap_or_default();
            let state = s.state.map(|st| st.to_string()).unwrap_or_default();
            // A concurrent remove may fail here — the row just lacks a start time.
            let started_at = docker
                .inspect_container(&id, None)
                .await
                .ok()
                .and_then(|info| info.state)
                .and_then(|st| st.started_at);
            agents.push(AgentInfo {
                id,
                name,
                project: labels
                    .get("agent.project")
                    .cloned()
                    .unwrap_or_else(|| "unknown".to_string()),
                origin: labels.get("agent.origin").cloned(),
                state,
                started_at,
                live: None,
                session_name: None,
                general_chat: labels.get("agent.generalchat").is_some_and(|v| v == "true"),
                model: None,
                thinking_level: None,
                runtime: RuntimeKind::Jarvis,
                directory: None,
            });
        }
        sort_agents(&mut agents);
        Ok(agents)
    }

    async fn labels(&self, id: &str) -> Result<Option<HashMap<String, String>>, RuntimeError> {
        let docker = Self::connect()?;
        match docker.inspect_container(id, None).await {
            Ok(info) => Ok(Some(info.config.and_then(|c| c.labels).unwrap_or_default())),
            // Gone container (or down daemon) reads as unknown — same rule
            // the old guard used.
            Err(_) => Ok(None),
        }
    }

    async fn attach(&self, id: &str) -> Result<AttachedAgent, RuntimeError> {
        let docker = Self::connect()?;
        let options = AttachContainerOptionsBuilder::new()
            .stdin(true)
            .stdout(true)
            .stderr(true)
            .stream(true)
            .logs(false)
            .build();
        let mut attached = docker
            .attach_container(id, Some(options))
            .await
            .map_err(|e| unknown_agent(id, e))?;
        let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<String>();
        let (stdout_tx, stdout_rx) = mpsc::unbounded_channel::<String>();
        let (stderr_tx, stderr_rx) = mpsc::unbounded_channel::<String>();

        // Bridge lines → container stdin.
        tokio::spawn(async move {
            while let Some(line) = stdin_rx.recv().await {
                let mut framed = line;
                if !framed.ends_with('\n') {
                    framed.push('\n');
                }
                if attached.input.write_all(framed.as_bytes()).await.is_err() {
                    break;
                }
            }
            let _ = attached.input.shutdown().await;
        });

        // Demuxed container output → bridge line channels.
        tokio::spawn(async move {
            let mut out_buf = String::new();
            let mut err_buf = String::new();
            loop {
                if stdout_tx.is_closed() && stderr_tx.is_closed() {
                    break;
                }
                let Some(item) = attached.output.next().await else {
                    break;
                };
                match item {
                    Ok(bollard::container::LogOutput::StdOut { message }) => {
                        push_lines(&stdout_tx, &mut out_buf, &message);
                    }
                    Ok(bollard::container::LogOutput::StdErr { message }) => {
                        push_lines(&stderr_tx, &mut err_buf, &message);
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            flush_line(&stdout_tx, &mut out_buf);
            flush_line(&stderr_tx, &mut err_buf);
        });

        Ok(AttachedAgent {
            stdin_tx,
            stdout_rx,
            stderr_rx,
        })
    }

    async fn stop_and_remove(&self, id: &str) -> Result<(), RuntimeError> {
        let docker = Self::connect()?;
        let stop = StopContainerOptionsBuilder::new().t(10).build();
        match docker.stop_container(id, Some(stop)).await {
            Ok(()) => {}
            Err(e) if is_gone_status(&e, &[304, 404, 409]) => {}
            Err(e) => return Err(docker_err(e)),
        }
        let remove = RemoveContainerOptionsBuilder::new().force(true).build();
        match docker.remove_container(id, Some(remove)).await {
            Ok(_) => {}
            Err(e) if is_gone_status(&e, &[404, 409]) => {}
            Err(e) => return Err(docker_err(e)),
        }
        Ok(())
    }

    async fn spawn(&self, opts: SpawnOptions) -> Result<String, RuntimeError> {
        let mut cmd = tokio::process::Command::new(&self.jarvis_bin);
        cmd.arg("rpc").arg(opts.project.display().to_string());
        if let Some(session) = &opts.session_path {
            cmd.arg("--session").arg(session);
        }
        if let Some(name) = &opts.name {
            cmd.arg("-n").arg(name);
        }
        if opts.general_chat {
            cmd.arg("--append-system-prompt")
                .arg(GENERAL_CHAT_SYSTEM_PROMPT);
        }
        if opts.read_only {
            cmd.env("PI_DASHBOARD_READONLY", "1");
        }
        if opts.general_chat {
            cmd.env("DASHBOARD_GENERAL_CHAT", "1");
        }
        let output = tokio::time::timeout(Duration::from_secs(120), cmd.output())
            .await
            .map_err(|_| RuntimeError::Spawn("jarvis rpc timed out after 120s".to_string()))?
            .map_err(|e| RuntimeError::Spawn(format!("jarvis rpc failed to start: {e}")))?;
        if !output.status.success() {
            return Err(RuntimeError::Spawn(format!(
                "jarvis rpc failed: {}",
                last_lines(&String::from_utf8_lossy(&output.stderr), 12)
            )));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        match stdout.lines().map(str::trim).rfind(|l| !l.is_empty()) {
            Some(id) => Ok(id.to_string()),
            None => Err(RuntimeError::Spawn(format!(
                "jarvis rpc printed no container id: {}",
                last_lines(&stdout, 12)
            ))),
        }
    }

    fn subscribe(&self) -> broadcast::Receiver<LifecycleEvent> {
        self.lifecycle_tx.subscribe()
    }
}

fn last_lines(text: &str, n: usize) -> String {
    let lines: Vec<_> = text.lines().collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_socket_fails_fast_at_call_time() {
        // Construction never dials; the error surfaces per call.
        let err = DockerRuntime::connect_for(Some("/nonexistent-xyz-docker.sock"))
            .unwrap_err()
            .to_string();
        assert!(err.starts_with("docker:"), "{err}");
    }

    #[tokio::test]
    async fn spawn_with_missing_jarvis_bin_errors() {
        let rt = DockerRuntime::new(PathBuf::from("/nonexistent-xyz/jarvis.sh"));
        let err = rt
            .spawn(SpawnOptions::jarvis(PathBuf::from(
                "/home/dev/projects/alpha",
            )))
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("jarvis"), "{err}");
    }

    #[test]
    fn gone_statuses_converge_on_success() {
        let not_found = BollardError::DockerResponseServerError {
            status_code: 404,
            message: "no such container".to_string(),
        };
        assert!(is_gone_status(&not_found, &[304, 404, 409]));
        assert!(!is_gone_status(&not_found, &[500]));
        assert!(matches!(
            unknown_agent("abc", not_found),
            RuntimeError::UnknownAgent(_)
        ));
    }

    #[test]
    fn line_pump_splits_and_flushes() {
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let mut buf = String::new();
        push_lines(&tx, &mut buf, b"{\"a\":1}\n{\"b\":");
        push_lines(&tx, &mut buf, b"2}\n");
        assert_eq!(rx.try_recv().unwrap(), "{\"a\":1}");
        assert_eq!(rx.try_recv().unwrap(), "{\"b\":2}");
        push_lines(&tx, &mut buf, b"partial");
        flush_line(&tx, &mut buf);
        assert_eq!(rx.try_recv().unwrap(), "partial");
    }
}
