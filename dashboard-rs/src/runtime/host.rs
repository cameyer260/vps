//! HostRuntime — bare-metal pi backend via the host supervisor socket.
//!
//! Port of `dashboard/server/runtime-host.ts` (+ the `host-supervisor.ts`
//! client). Same seam as Docker: the bridge only ever sees line channels.
//! Degrades to an empty list / clear spawn error when the supervisor socket
//! is absent — never breaks the jarvis path. Protocol reference:
//! `docs/host-pi.md`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt as _, AsyncReadExt as _, AsyncWriteExt as _};
use tokio::sync::{broadcast, mpsc};

use super::{
    AgentInfo, AttachedAgent, LifecycleAction, LifecycleEvent, Runtime, RuntimeError, RuntimeKind,
    SpawnOptions, flush_line, push_lines, sort_agents,
};

/// Host agent ids are `host-<ts>-<seq>` and never collide with container hex.
pub const HOST_PREFIX: &str = "host-";

pub fn is_host_id(id: &str) -> bool {
    id.starts_with(HOST_PREFIX)
}

const WATCHED: &[&str] = &["start", "die", "destroy", "rename"];

/// Supervisor client. Construction only stores the socket path and starts
/// the lifecycle forwarder; every call dials fresh.
pub struct HostRuntime {
    sock_path: PathBuf,
    lifecycle_tx: broadcast::Sender<LifecycleEvent>,
}

impl HostRuntime {
    pub fn new(sock_path: PathBuf) -> Self {
        let (lifecycle_tx, _) = broadcast::channel(256);
        let this = Self {
            sock_path,
            lifecycle_tx,
        };
        this.spawn_subscribe_task();
        this
    }

    fn down_error(&self) -> RuntimeError {
        RuntimeError::Host(format!(
            "host supervisor not running ({}; systemctl --user enable --now pi-host-supervisor.service — see docs/host-pi.md)",
            self.sock_path.display()
        ))
    }

    /// One request → one JSON reply line (unary ops).
    async fn rpc(
        &self,
        req: &serde_json::Value,
        timeout: Duration,
    ) -> Result<serde_json::Value, RuntimeError> {
        let sock = tokio::net::UnixStream::connect(&self.sock_path)
            .await
            .map_err(|_| self.down_error())?;
        let (read_half, mut write_half) = sock.into_split();
        let mut reader = tokio::io::BufReader::new(read_half);
        let mut line = String::new();
        let req_line = req.to_string() + "\n";
        tokio::time::timeout(timeout, async {
            write_half
                .write_all(req_line.as_bytes())
                .await
                .map_err(|_| self.down_error())?;
            reader
                .read_line(&mut line)
                .await
                .map_err(|_| self.down_error())?;
            Ok::<_, RuntimeError>(())
        })
        .await
        .map_err(|_| RuntimeError::Host("host supervisor: response timeout".to_string()))??;
        serde_json::from_str(line.trim())
            .map_err(|_| RuntimeError::Host("host supervisor: bad reply".to_string()))
    }

    async fn logs(&self, id: &str) -> Vec<String> {
        match self
            .rpc(
                &serde_json::json!({ "op": "logs", "id": id }),
                Duration::from_secs(15),
            )
            .await
        {
            Ok(res) if res.get("ok").and_then(|v| v.as_bool()) == Some(true) => res
                .get("stderr")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
            _ => Vec::new(),
        }
    }

    fn spawn_subscribe_task(&self) {
        let path = self.sock_path.clone();
        let tx = self.lifecycle_tx.clone();
        tokio::spawn(async move {
            loop {
                pump_subscribe(&path, &tx).await;
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        });
    }
}

/// Long-lived `subscribe` connection; reconnects with backoff via the caller loop.
async fn pump_subscribe(path: &PathBuf, tx: &broadcast::Sender<LifecycleEvent>) {
    let sock = match tokio::net::UnixStream::connect(path).await {
        Ok(s) => s,
        Err(_) => return,
    };
    let (read_half, mut write_half) = sock.into_split();
    if write_half
        .write_all(b"{\"op\":\"subscribe\"}\n")
        .await
        .is_err()
    {
        return;
    }
    let mut reader = tokio::io::BufReader::new(read_half);
    let mut line = String::new();
    let mut shook_hands = false;
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => return, // supervisor went away — caller resubscribes
            Ok(_) => {}
            Err(_) => return,
        }
        let msg: serde_json::Value = match serde_json::from_str(line.trim()) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !shook_hands {
            // First line is the {"ok":true} handshake.
            shook_hands = msg.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
            continue;
        }
        let (Some(action), Some(id)) = (
            msg.get("action").and_then(|v| v.as_str()),
            msg.get("id").and_then(|v| v.as_str()),
        ) else {
            continue;
        };
        let action = match action {
            "start" => LifecycleAction::Start,
            "die" => LifecycleAction::Die,
            "destroy" => LifecycleAction::Destroy,
            "rename" => LifecycleAction::Rename,
            _ => continue,
        };
        if !WATCHED.contains(&action.as_str()) {
            continue;
        }
        let _ = tx.send(LifecycleEvent {
            action,
            id: id.to_string(),
        });
    }
}

impl Runtime for HostRuntime {
    async fn list(&self) -> Result<Vec<AgentInfo>, RuntimeError> {
        let res = match self
            .rpc(
                &serde_json::json!({ "op": "list" }),
                Duration::from_secs(15),
            )
            .await
        {
            // Supervisor down — jarvis agents still list via Docker.
            Ok(res) => res,
            Err(_) => return Ok(Vec::new()),
        };
        if res.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            return Ok(Vec::new());
        }
        let mut agents: Vec<AgentInfo> = res
            .get("agents")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|a| {
                Some(AgentInfo {
                    id: a.get("id")?.as_str()?.to_string(),
                    name: a.get("id")?.as_str()?.to_string(),
                    project: a.get("project")?.as_str()?.to_string(),
                    directory: a
                        .get("directory")
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                    origin: Some("dashboard".to_string()),
                    state: a
                        .get("state")
                        .and_then(|v| v.as_str())
                        .unwrap_or("running")
                        .to_string(),
                    started_at: a
                        .get("startedAt")
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                    live: None,
                    session_name: None,
                    general_chat: false,
                    model: None,
                    thinking_level: None,
                    runtime: RuntimeKind::Host,
                })
            })
            .collect();
        sort_agents(&mut agents);
        Ok(agents)
    }

    async fn labels(&self, id: &str) -> Result<Option<HashMap<String, String>>, RuntimeError> {
        if !is_host_id(id) {
            return Ok(None);
        }
        let agents = self.list().await?;
        let Some(found) = agents.iter().find(|a| a.id == id) else {
            return Ok(None);
        };
        let mut labels = HashMap::new();
        labels.insert("agent.kind".to_string(), "pi".to_string());
        labels.insert("agent.project".to_string(), found.project.clone());
        labels.insert("agent.origin".to_string(), "dashboard".to_string());
        labels.insert("agent.runtime".to_string(), "host".to_string());
        if let Some(dir) = &found.directory {
            labels.insert("agent.directory".to_string(), dir.clone());
        }
        Ok(Some(labels))
    }

    async fn attach(&self, id: &str) -> Result<AttachedAgent, RuntimeError> {
        let sock = tokio::net::UnixStream::connect(&self.sock_path)
            .await
            .map_err(|_| self.down_error())?;
        let (read_half, mut write_half) = sock.into_split();
        // The attach request goes first; the server replies {"ok":true}
        // and switches the connection to raw proxy mode.
        let req = serde_json::json!({ "op": "attach", "id": id }).to_string() + "\n";
        write_half
            .write_all(req.as_bytes())
            .await
            .map_err(|_| self.down_error())?;
        let mut reader = tokio::io::BufReader::new(read_half);
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(15), reader.read_line(&mut line))
            .await
            .map_err(|_| RuntimeError::Host("host supervisor: attach timeout".to_string()))?
            .map_err(|_| self.down_error())?;
        let res: serde_json::Value = serde_json::from_str(line.trim())
            .map_err(|_| RuntimeError::Host("host supervisor: bad attach reply".to_string()))?;
        if res.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            let msg = res
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("host attach failed");
            return Err(RuntimeError::Host(msg.to_string()));
        }
        // The handshake line can share a chunk with early pi output: the
        // buffered remainder seeds the stdout line buffer so the first
        // JSONL frame survives intact.
        let buffered = reader.buffer().to_vec();
        let mut read_half = reader.into_inner();

        let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<String>();
        let (stdout_tx, stdout_rx) = mpsc::unbounded_channel::<String>();
        let (stderr_tx, stderr_rx) = mpsc::unbounded_channel::<String>();
        // Diagnostics prefill (non-fatal when the agent just started).
        for line in self.logs(id).await.iter().rev().take(50).rev() {
            if stderr_tx.send(line.clone()).is_err() {
                break;
            }
        }
        // Bridge lines → pi stdin. Bridge teardown (dropping stdin_tx)
        // closes pi stdin, like the old socket destroy.
        tokio::spawn(async move {
            while let Some(line) = stdin_rx.recv().await {
                let mut framed = line;
                if !framed.ends_with('\n') {
                    framed.push('\n');
                }
                if write_half.write_all(framed.as_bytes()).await.is_err() {
                    break;
                }
            }
            let _ = write_half.shutdown().await;
        });
        // Pi stdout → bridge lines. EOF ends the session: stderr closes
        // with it so the bridge's exited path fires.
        tokio::spawn(async move {
            // Emit any complete lines already buffered past the handshake.
            let mut buf = String::from_utf8_lossy(&buffered).into_owned();
            push_lines(&stdout_tx, &mut buf, b"");
            let mut chunk = [0u8; 8192];
            loop {
                if stdout_tx.is_closed() {
                    break;
                }
                match read_half.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => push_lines(&stdout_tx, &mut buf, &chunk[..n]),
                }
            }
            flush_line(&stdout_tx, &mut buf);
            drop(stderr_tx);
        });
        Ok(AttachedAgent {
            stdin_tx,
            stdout_rx,
            stderr_rx,
        })
    }

    async fn stop_and_remove(&self, id: &str) -> Result<(), RuntimeError> {
        match self
            .rpc(
                &serde_json::json!({ "op": "kill", "id": id }),
                Duration::from_secs(15),
            )
            .await
        {
            Ok(res) if res.get("ok").and_then(|v| v.as_bool()) == Some(true) => Ok(()),
            Ok(res) => {
                let msg = res
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("host kill failed");
                // Idempotent like Docker 404: a gone agent is success, and a
                // down-supervisor error for a non-host id is not ours to raise.
                if msg.to_lowercase().contains("unknown agent") || !is_host_id(id) {
                    Ok(())
                } else {
                    Err(RuntimeError::Host(msg.to_string()))
                }
            }
            Err(e) if !is_host_id(id) => {
                let _ = e;
                Ok(())
            }
            Err(e) => Err(e),
        }
    }

    async fn spawn(&self, opts: SpawnOptions) -> Result<String, RuntimeError> {
        // Fixed pi argv only (supervisor rule): cwd + optional resume/name.
        // No model passthrough, no read-only extension, no General Chat.
        let mut req = serde_json::json!({ "op": "spawn", "cwd": opts.project });
        if let Some(session) = &opts.session_path {
            req["sessionPath"] = serde_json::Value::String(session.to_string_lossy().into_owned());
        }
        if let Some(name) = &opts.name {
            req["name"] = serde_json::Value::String(name.clone());
        }
        let res = self.rpc(&req, Duration::from_secs(60)).await?;
        if res.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            let msg = res
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("host spawn failed");
            return Err(RuntimeError::Host(msg.to_string()));
        }
        res.get("id")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| RuntimeError::Host("host spawn returned no id".to_string()))
    }

    fn subscribe(&self) -> broadcast::Receiver<LifecycleEvent> {
        self.lifecycle_tx.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn missing_sock() -> PathBuf {
        PathBuf::from("/nonexistent-xyz-pi-host-supervisor.sock")
    }

    #[test]
    fn host_ids_carry_the_prefix() {
        assert!(is_host_id("host-123-1"));
        assert!(!is_host_id("abc123"));
        assert!(!is_host_id("mock-1"));
    }

    #[tokio::test]
    async fn list_degrades_to_empty_without_supervisor() {
        let rt = HostRuntime::new(missing_sock());
        assert!(rt.list().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn labels_miss_without_dialing_or_daemon() {
        let rt = HostRuntime::new(missing_sock());
        assert!(rt.labels("abc123").await.unwrap().is_none());
        assert!(rt.labels("host-1-2").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn stop_is_idempotent_for_foreign_ids() {
        let rt = HostRuntime::new(missing_sock());
        // A down supervisor with a non-host id is not our error to raise.
        rt.stop_and_remove("abc123").await.unwrap();
        // …but a host id against a down supervisor is a real error.
        let err = rt
            .stop_and_remove("host-1-2")
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("not running"), "{err}");
    }

    #[tokio::test]
    async fn spawn_and_attach_fail_clearly_without_supervisor() {
        let rt = HostRuntime::new(missing_sock());
        let err = rt
            .spawn(SpawnOptions {
                project: PathBuf::from("/home/dev/notes"),
                runtime: RuntimeKind::Host,
                ..SpawnOptions::jarvis(PathBuf::from("/home/dev/notes"))
            })
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("not running"), "{err}");
        let err = rt.attach("host-1-2").await.unwrap_err().to_string();
        assert!(err.contains("not running"), "{err}");
    }
}
