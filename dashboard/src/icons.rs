//! The app's icons and its web app manifest.
//!
//! The files live in `assets/icons/` with the other vendored assets, and the
//! head and the manifest point at them through `/static/icons/…?v=<fingerprint>`
//! — so they are cached for a year like every other asset and re-fetched only
//! when a file actually changes. That matters more here than for a stylesheet:
//! an *unchanged* `apple-touch-icon` URL is exactly what iOS keeps serving from
//! its own cache, so a stable URL is how a replaced icon fails to appear on a
//! home screen.
//!
//! The same files also answer at the site root (`/favicon.ico`,
//! `/apple-touch-icon.png`, …), for the clients that never read the HTML: iOS
//! falls back to probing those paths when a page declares no icon, and a
//! browser, a link preview or a bookmark tile that is given no icon asks for
//! `/favicon.ico`. Those URLs cannot carry the fingerprint, so that copy is
//! cached for an hour — long enough that the fallback is not re-fetched on
//! every page load, short enough that a replaced icon still lands the same day.
//! See "Decisions and why" in `docs/ARCHITECTURE.md`.
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

/// The icon files, for the root-path fallback above, and the content type each
/// is served with. `image/x-icon` rather than the IANA `image/vnd.microsoft.icon`
/// so that this copy and the `/static` one — which takes its type from the file
/// extension — cannot disagree.
const ICONS: [(&str, &str); 7] = [
    ("favicon.ico", "image/x-icon"),
    ("favicon.svg", "image/svg+xml"),
    ("favicon-16x16.png", "image/png"),
    ("favicon-32x32.png", "image/png"),
    ("apple-touch-icon.png", "image/png"),
    ("icon-192.png", "image/png"),
    ("icon-512.png", "image/png"),
];

/// How long a client may keep an icon fetched through a root path without
/// asking again. Short enough that a changed icon lands the same day, long
/// enough that the fallback is not re-fetched on every page load. The icons the
/// pages actually declare are under `/static` and cached for a year instead.
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

/// `GET /favicon.ico`, `/apple-touch-icon.png`, … — the root-path copy of the
/// set, one handler keyed by the path it was reached by. Only the names above
/// are readable, so no request path can reach a file of its choosing.
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
    // The manifest names the icons by their fingerprinted URLs, so a browser
    // that re-reads it after a deploy fetches the new files and not a year-old
    // cached copy of the old ones.
    let version = &config.asset_version;
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
                "src": format!("/static/icons/icon-192.png?v={version}"),
                "sizes": "192x192",
                "type": "image/png",
                "purpose": "any maskable",
            },
            {
                "src": format!("/static/icons/icon-512.png?v={version}"),
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
