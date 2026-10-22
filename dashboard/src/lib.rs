//! The admin site: a read-only, Obsidian-quality browser for the notes repo,
//! plus a surface for publishing throwaway pages.
//!
//! `main.rs` is the thin binary (config, logging, listener, shutdown); this
//! library owns the router, so tests boot it in-process without a socket.
//!
//! Built: deployment-time configuration (`config`), the notes browser
//! (`notes`, `render`), published pages (`publish`), the `/static` asset mount,
//! the app's icons and web app manifest (`icons`), and the health endpoint.

pub mod config;
pub mod icons;
pub mod notes;
pub mod publish;
pub mod render;

use std::sync::Arc;

use crate::notes::{home, note, search};
use axum::Router;
use axum::extract::Request;
use axum::http::{HeaderValue, header};
use axum::middleware::Next;
use axum::response::Response;
use axum::routing::get;
use tower_http::services::ServeDir;

use crate::config::Config;

/// Assemble the router. Takes `&Config` so the binary and the tests wire the
/// same routes the same way.
pub fn app(config: &Config) -> Router {
    Router::new()
        // Every notes route answers an htmx request with the reading pane's
        // contents alone (a fragment), and a plain request with the full page.
        .route("/", get(home))
        .route("/search", get(search))
        .route("/download/notes/{*path}", get(crate::notes::download))
        .route("/notes/{*path}", get(note))
        // Liveness for the service check (systemd) and for a curl.
        .route("/health", get(health))
        // Published pages are served verbatim from their confined filesystem root.
        .merge(publish::routes())
        // The icons and the manifest, at the root paths their clients ask for.
        .merge(icons::routes())
        // Vendored assets, served from disk. No CDN, no npm.
        .nest_service("/static", ServeDir::new(&config.assets_dir))
        // The asset URLs carry a fingerprint of their contents, so they can be
        // cached hard: a deploy changes the fingerprint and every cache — the
        // browser's and Cloudflare's — fetches the new file.
        .layer(axum::middleware::from_fn(immutable_assets))
        .with_state(Arc::new(config.clone()))
}

/// `GET /health` — 200 with a short body.
async fn health() -> &'static str {
    "ok"
}

/// Fingerprinted assets never change in place, so they may be cached for a year.
async fn immutable_assets(request: Request, next: Next) -> Response {
    let is_asset = request.uri().path().starts_with("/static/");
    let mut response = next.run(request).await;
    if is_asset {
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=31536000, immutable"),
        );
    }
    response
}
