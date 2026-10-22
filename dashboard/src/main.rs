//! The `dashboard` binary: load configuration, initialise logging, serve the
//! router from `dashboard::app`, and shut down cleanly on SIGINT/SIGTERM
//! (systemd sends the latter; restart and boot behaviour belong to the unit).

use std::net::SocketAddr;
use std::process::ExitCode;

use dashboard::config::Config;

#[tokio::main]
async fn main() -> ExitCode {
    let config = Config::from_env();
    // LOG_LEVEL is the documented knob; RUST_LOG, when set, still wins.
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or(&config.log_level))
        .init();

    for warning in config.boot_warnings() {
        log::warn!("{warning}");
    }
    log::info!(
        "notes root: {} (read-only), published root: {}",
        config.notes_root.display(),
        config.published_root.display()
    );

    let addr = SocketAddr::from(([0, 0, 0, 0], config.port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(err) => {
            log::error!("failed to bind {addr}: {err}");
            return ExitCode::FAILURE;
        }
    };
    log::info!("listening on http://{addr}");

    if let Err(err) = axum::serve(listener, dashboard::app(&config))
        .with_graceful_shutdown(shutdown_signal())
        .await
    {
        log::error!("server error: {err}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

/// SIGINT (Ctrl-C) or SIGTERM (systemd stop/restart); in-flight requests
/// drain via axum's graceful shutdown.
async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => signal.recv().await,
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
