//! dashboard-rs: Rust port of the VPS admin dashboard.
//!
//! Phase 1 (scaffold): config with Q12 parity, Askama app shell with
//! hx-boost + bottom nav, static assets via ServeDir. Later phases add the
//! runtime seam (2), bridge (3), agents UI (4), notes IDE (5), PWA (6),
//! and the supervisor binary (7). See `docs/rust-port.md` + ADRs 0001–0005.

use std::net::SocketAddr;

use dashboard_rs::config::Config;
use dashboard_rs::runtime;
use dashboard_rs::shell;

#[tokio::main]
async fn main() {
    env_logger::init();
    let config = Config::from_env();
    // Wire the runtime seam at boot: unknown MOCK_SCENARIO names fail
    // fast here, before the listener opens. Phase 3+ hangs routes off it;
    // until then the boot log proves which backend is live.
    let _runtime = match runtime::select_runtime(&config) {
        Ok(rt) => {
            log::info!("runtime: {}", rt.describe());
            rt
        }
        Err(err) => {
            log::error!("runtime init failed: {err}");
            std::process::exit(1);
        }
    };
    let addr = SocketAddr::from(([0, 0, 0, 0], config.port));
    let app = shell::router(&config);

    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(err) => {
            log::error!("failed to bind {addr}: {err}");
            std::process::exit(1);
        }
    };
    log::info!("dashboard listening on http://0.0.0.0:{}", config.port);

    if let Err(err) = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
    {
        log::error!("server error: {err}");
    }
}

/// SIGINT/SIGTERM shutdown (mirrors the old server's signal handlers).
/// A phone-facing service logs and exits cleanly; in-flight connections
/// drain via graceful shutdown.
async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => sig.recv().await,
            Err(_) => std::future::pending::<Option<()>>().await,
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<Option<()>>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    log::info!("shutting down");
}
