//! Global fan-out hub (port of `dashboard/server/events.ts`).
//!
//! The agent list is push-based; there is no polling. Container lifecycle
//! transitions (via the runtime seam's `subscribe`) and per-agent bridge
//! status transitions both land here; Phase 4 serves them as the global SSE
//! agent feed (the old `/ws/events`). Phase 3 owns the hub and the bridge's
//! publishing half so status/rename/exited semantics are tested before any
//! UI consumes them.

use tokio::sync::broadcast;

use crate::runtime::SelectedRuntime;
use std::sync::Arc;

/// Dashboard-wide event: either a lifecycle transition (→ refetch
/// `GET /api/agents`) or a live status transition (→ patch the card).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GlobalEvent {
    AgentStatus {
        id: String,
        project: String,
        status: String,
    },
    AgentsChanged {
        action: String,
        id: String,
    },
}

impl GlobalEvent {
    /// SSE event name on the Phase 4 feed (both travel as named events).
    pub fn event_name(&self) -> &'static str {
        match self {
            GlobalEvent::AgentStatus { .. } => "agent_status",
            GlobalEvent::AgentsChanged { .. } => "agents_changed",
        }
    }

    /// JSON payload for the SSE `data` line.
    pub fn payload(&self) -> serde_json::Value {
        match self {
            GlobalEvent::AgentStatus {
                id,
                project,
                status,
            } => serde_json::json!({ "id": id, "project": project, "status": status }),
            GlobalEvent::AgentsChanged { action, id } => {
                serde_json::json!({ "action": action, "id": id })
            }
        }
    }
}

/// The hub: one sender held by `AppState`, cloned into every bridge.
/// Lagged receivers skip (a refetch is the resync path, as before).
#[derive(Clone, Debug)]
pub struct EventHub {
    tx: broadcast::Sender<GlobalEvent>,
}

impl EventHub {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(256);
        Self { tx }
    }

    pub fn publish(&self, event: GlobalEvent) {
        let _ = self.tx.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<GlobalEvent> {
        self.tx.subscribe()
    }
}

impl Default for EventHub {
    fn default() -> Self {
        Self::new()
    }
}

/// Forward runtime lifecycle transitions onto the hub (port of
/// `watchDockerEvents` in `server/events.ts`): the transport lives in the
/// runtime seam, here we only fan out. Phase 4 serves the hub as the
/// global SSE agent feed.
pub fn forward_lifecycle(runtime: Arc<SelectedRuntime>, hub: EventHub) {
    let mut rx = runtime.subscribe();
    tokio::spawn(async move {
        while let Ok(ev) = rx.recv().await {
            hub.publish(GlobalEvent::AgentsChanged {
                action: ev.action.as_str().to_string(),
                id: ev.id,
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_and_lifecycle_shapes() {
        let status = GlobalEvent::AgentStatus {
            id: "abc".to_string(),
            project: "alpha".to_string(),
            status: "streaming".to_string(),
        };
        assert_eq!(status.event_name(), "agent_status");
        assert_eq!(status.payload()["status"], "streaming");
        let changed = GlobalEvent::AgentsChanged {
            action: "rename".to_string(),
            id: "abc".to_string(),
        };
        assert_eq!(changed.event_name(), "agents_changed");
        assert_eq!(changed.payload()["action"], "rename");
    }

    #[tokio::test]
    async fn hub_fans_out() {
        let hub = EventHub::new();
        let mut rx = hub.subscribe();
        hub.publish(GlobalEvent::AgentsChanged {
            action: "start".to_string(),
            id: "x".to_string(),
        });
        let ev = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            ev,
            GlobalEvent::AgentsChanged {
                action: "start".to_string(),
                id: "x".to_string(),
            }
        );
    }
}
