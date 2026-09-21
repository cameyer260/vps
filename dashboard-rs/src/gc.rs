//! Idle reaper for General Chat agents (port of `server/gc-reaper.ts`).
//!
//! GC chats are hidden from the Agents tab and live only in the GC tab,
//! whose open id is kept in the browser. If the page is gone for good the
//! container would otherwise run forever with no UI pointing at it: every
//! sweep, any dashboard-owned running GC agent whose bridge has had zero
//! viewers for longer than the timeout is terminated exactly like the
//! terminate route does (stop + remove, bridge destroyed so open tabs
//! render `exited`).
//!
//! Briefly backgrounding the app is safe: sockets reconnect in seconds and
//! the timeout (default 1h) only counts continuous viewer-free time. Agents
//! with an open tab — or not yet attached this server lifetime — are
//! skipped. A zero timeout disables the reaper. The same sweep prunes
//! long-exited bridges (see [`crate::bridge::BridgeRegistry::prune_exited`]).

use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::bridge::BridgeRegistry;
use crate::runtime::SelectedRuntime;

/// Sweep period: half the timeout, clamped to [2s, 60s] (port of
/// `sweepIntervalMs`).
pub fn sweep_interval_ms(timeout_ms: u64) -> u64 {
    (timeout_ms / 2).clamp(2_000, 60_000)
}

/// One sweep: terminate idle GC agents, prune long-exited bridges.
pub async fn sweep_once(
    runtime: &SelectedRuntime,
    registry: &BridgeRegistry,
    timeout_ms: u64,
    now: Instant,
) {
    if timeout_ms == 0 {
        return;
    }
    let agents = match runtime.list().await {
        Ok(agents) => agents,
        Err(err) => {
            log::error!("[gc-reaper] list failed: {err}");
            return;
        }
    };
    for agent in agents {
        if !agent.general_chat || agent.origin.as_deref() != Some("dashboard") {
            continue;
        }
        if agent.state != "running" {
            continue;
        }
        let Some(bridge) = registry.get(&agent.id) else {
            continue; // not attached yet — a later sweep picks it up
        };
        if bridge.client_count() > 0 {
            continue; // viewers attached
        }
        if now
            .saturating_duration_since(bridge.idle_since())
            .as_millis()
            < u128::from(timeout_ms)
        {
            continue;
        }
        log::info!("[gc-reaper] terminating idle general chat {}", agent.id);
        if let Err(err) = registry.terminate(&agent.id).await {
            log::error!("[gc-reaper] stop failed for {}: {err}", agent.id);
        }
    }
    let pruned = registry.prune_exited(now);
    if pruned > 0 {
        log::info!("[gc-reaper] pruned {pruned} exited bridge(s)");
    }
}

/// Start the background sweep task. A zero timeout logs and returns
/// without spawning (reaper disabled).
pub fn start_gc_reaper(
    runtime: Arc<SelectedRuntime>,
    registry: Arc<BridgeRegistry>,
    timeout_ms: u64,
) {
    if timeout_ms == 0 {
        log::info!("[gc-reaper] disabled (GC_IDLE_TIMEOUT_MS <= 0)");
        return;
    }
    let every_ms = sweep_interval_ms(timeout_ms);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(every_ms));
        loop {
            interval.tick().await;
            sweep_once(&runtime, &registry, timeout_ms, Instant::now()).await;
        }
    });
    log::info!(
        "[gc-reaper] sweeping idle general chats every {}s (timeout {}s)",
        every_ms / 1000,
        timeout_ms / 1000
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::BridgeRegistry;
    use crate::events::EventHub;
    use crate::runtime::{Runtime, SpawnOptions};
    use std::path::PathBuf;

    fn registry_with_mock(scenario: &str) -> (Arc<SelectedRuntime>, Arc<BridgeRegistry>) {
        let dir = PathBuf::from("/tmp/dashboard-rs-gc-test");
        let mock = crate::runtime::mock::MockRuntime::from_scenario(scenario, &dir).unwrap();
        let runtime = Arc::new(SelectedRuntime::Mock(Arc::new(mock)));
        let registry = Arc::new(BridgeRegistry::new(Arc::clone(&runtime), EventHub::new()));
        (runtime, registry)
    }

    #[test]
    fn interval_clamps_like_the_old_reaper() {
        assert_eq!(sweep_interval_ms(3_600_000), 60_000);
        assert_eq!(sweep_interval_ms(60_000), 30_000);
        assert_eq!(sweep_interval_ms(2_000), 2_000);
        assert_eq!(sweep_interval_ms(100), 2_000);
    }

    #[tokio::test]
    async fn idle_gc_agent_is_terminated() {
        let (runtime, registry) = registry_with_mock("gc-chat");
        let agents = runtime.list().await.unwrap();
        assert_eq!(agents.len(), 1);
        let id = agents[0].id.clone();
        // Attach so the bridge exists, then fake a long-idle viewer-free age.
        let bridge = registry.ensure(&id, None).await.unwrap();
        bridge.set_idle_since(Instant::now() - Duration::from_secs(7200));
        drop(bridge);
        sweep_once(&runtime, &registry, 3_600_000, Instant::now()).await;
        assert!(runtime.list().await.unwrap().is_empty());
        assert!(registry.get(&id).is_none());
    }

    #[tokio::test]
    async fn viewed_and_fresh_gc_agents_survive() {
        let (runtime, registry) = registry_with_mock("gc-chat");
        let agents = runtime.list().await.unwrap();
        let id = agents[0].id.clone();
        let bridge = registry.ensure(&id, None).await.unwrap();
        // A viewer is attached: skip even when the idle clock is ancient.
        let _guard = bridge.viewing();
        bridge.set_idle_since(Instant::now() - Duration::from_secs(7200));
        sweep_once(&runtime, &registry, 3_600_000, Instant::now()).await;
        assert_eq!(runtime.list().await.unwrap().len(), 1);
        drop(_guard);
        // Fresh idle clock: skip even with no viewers.
        bridge.set_idle_since(Instant::now());
        sweep_once(&runtime, &registry, 3_600_000, Instant::now()).await;
        assert_eq!(runtime.list().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn non_gc_agents_and_disabled_reaper_are_skipped() {
        let (runtime, registry) = registry_with_mock("sidebar-full");
        for agent in runtime.list().await.unwrap() {
            let bridge = registry.ensure(&agent.id, None).await.unwrap();
            bridge.set_idle_since(Instant::now() - Duration::from_secs(7200));
        }
        sweep_once(&runtime, &registry, 3_600_000, Instant::now()).await;
        assert_eq!(runtime.list().await.unwrap().len(), 3);
        // Disabled reaper never terminates, even when everything is stale.
        sweep_once(&runtime, &registry, 0, Instant::now()).await;
        assert_eq!(runtime.list().await.unwrap().len(), 3);
    }

    #[tokio::test]
    async fn unattached_gc_agents_are_skipped() {
        // No bridge yet (not attached this server lifetime): the sweep
        // leaves the agent alone for a later pass.
        let (runtime, registry) = registry_with_mock("gc-chat");
        sweep_once(&runtime, &registry, 1, Instant::now()).await;
        assert_eq!(runtime.list().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn spawn_marks_project_and_gc_flag_for_the_reaper() {
        let (runtime, _) = registry_with_mock("empty");
        let mock = match runtime.as_ref() {
            SelectedRuntime::Mock(mock) => Arc::clone(mock),
            SelectedRuntime::Prod(..) => unreachable!(),
        };
        let id = mock
            .spawn(SpawnOptions {
                project: PathBuf::from("/home/dev/notes"),
                general_chat: true,
                ..SpawnOptions::jarvis(PathBuf::from("/home/dev/notes"))
            })
            .await
            .unwrap();
        let agents = runtime.list().await.unwrap();
        assert_eq!(agents.len(), 1);
        assert!(agents[0].general_chat);
        assert_eq!(agents[0].id, id);
    }
}
