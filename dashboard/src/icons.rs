//! The app's icons and its web app manifest.
//!
//! The icon files live in `assets/icons/` with the other vendored assets, but
//! they are served from the *site root* (`/favicon.ico`, `/apple-touch-icon.png`,
//! …) rather than from `/static`, because the clients that need them most do not
//! read the HTML: iOS probes `/apple-touch-icon.png` when a page is added to the
//! home screen, a browser with no declared icon asks for `/favicon.ico`, and a
//! link preview or a bookmark tile does the same. Root URLs cannot carry the
//! asset fingerprint, so these are cached for an hour instead of a year — the
//! same files under `/static/icons/` would be cached forever and could never be
//! replaced. See "Decisions and why" in `docs/ARCHITECTURE.md`.
//!
//! `/site.webmanifest` is built here rather than served from disk because it
//! carries the vault's name.

use std::sync::Arc;

use axum::Router;
use axum::extract::{Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;

use crate::config::Config;

/// The icon files and the content type each one is served with.
const ICONS: [(&str, &str); 7] = [
    ("favicon.ico", "image/vnd.microsoft.icon"),
    ("favicon.svg", "image/svg+xml"),
    ("favicon-16x16.png", "image/png"),
    ("favicon-32x32.png", "image/png"),
    ("apple-touch-icon.png", "image/png"),
    ("icon-192.png", "image/png"),
    ("icon-512.png", "image/png"),
];

/// How long a browser may keep an icon without asking again. Short enough that
/// a changed icon lands the same day, long enough that a page load does not
/// re-fetch seven files.
const ICON_CACHE: &str = "public, max-age=3600";

/// The app's background, for the browser chrome and the install splash. The
/// same value as `--background-primary` in `assets/css/input.css` and the
/// `theme-color` meta in the two templates: it is the icon's own background, so
/// an installed app's status bar and splash match the tile.
const BACKGROUND: &str = "#1e1e1e";

pub(crate) fn routes() -> Router<Arc<Config>> {
    let mut router = Router::new().route("/site.webmanifest", get(manifest));
    for (name, _) in ICONS {
        router = router.route(&format!("/{name}"), get(icon));
    }
    router
}

/// `GET /favicon.ico`, `/apple-touch-icon.png`, … — one handler for the set,
/// keyed by the path it was reached by. Only the names above are readable, so
/// no request path can reach a file of its choosing.
async fn icon(State(config): State<Arc<Config>>, request: Request) -> Response {
    let name = request.uri().path().trim_start_matches('/');
    let Some((_, content_type)) = ICONS.iter().find(|(file, _)| *file == name) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let path = config.assets_dir.join("icons").join(name);
    match std::fs::read(&path) {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, *content_type),
                (header::CACHE_CONTROL, ICON_CACHE),
            ],
            bytes,
        )
            .into_response(),
        Err(err) => {
            log::error!("icon {name} unreadable at {}: {err}", path.display());
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

/// `GET /site.webmanifest` — what a phone reads to install the site: the name,
/// the colours, the standalone window, and the two icon sizes.
async fn manifest(State(config): State<Arc<Config>>) -> Response {
    let vault = config.vault_name();
    // Written by a JSON library, not formatted by hand: the vault's name is a
    // filesystem name, and a quote or a backslash in it must not be able to
    // break the document the browser has to parse.
    let body = serde_json::json!({
        "name": format!("{vault} — admin"),
        "short_name": vault,
        "start_url": "/",
        "scope": "/",
        // Without this, an installed app still opens with browser chrome.
        "display": "standalone",
        "background_color": BACKGROUND,
        "theme_color": BACKGROUND,
        // One file per size for both purposes: the mark sits inside the 80%
        // safe circle of the full-bleed tile, so a launcher's mask has nothing
        // to crop and the "any" case needs no second, padded icon.
        "icons": [
            {
                "src": "/icon-192.png",
                "sizes": "192x192",
                "type": "image/png",
                "purpose": "any maskable",
            },
            {
                "src": "/icon-512.png",
                "sizes": "512x512",
                "type": "image/png",
                "purpose": "any maskable",
            },
        ],
    })
    .to_string();
    (
        [
            (header::CONTENT_TYPE, "application/manifest+json"),
            (header::CACHE_CONTROL, ICON_CACHE),
        ],
        body,
    )
        .into_response()
}
