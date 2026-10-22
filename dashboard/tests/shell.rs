//! Boots the router in-process (no socket) and checks the walking skeleton:
//! the shell renders, health answers, and the vendored assets are served from
//! `/static`.

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode, header};
use axum::response::Response;
use dashboard::config::Config;
use tower::ServiceExt;

/// Default configuration: notes root at the host path, assets from the
/// crate's own `assets/` (the working directory of a cargo run/test).
fn config() -> Config {
    Config::from_lookup(|_| None)
}

async fn get(config: &Config, uri: &str) -> Response {
    get_with(config, uri, &[]).await
}

async fn get_with(config: &Config, uri: &str, headers: &[(&str, &str)]) -> Response {
    let mut builder = Request::builder().uri(uri);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    dashboard::app(config)
        .oneshot(builder.body(Body::empty()).expect("request builds"))
        .await
        .expect("router responds")
}

fn vault_config(root: &std::path::Path) -> Config {
    let root = root.display().to_string();
    Config::from_lookup(|key| (key == "NOTES_DIR").then(|| root.clone()))
}

fn temp_vault() -> std::path::PathBuf {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "dashboard-route-test-{}-{nonce}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    root
}

async fn body_text(response: Response) -> String {
    let bytes = to_bytes(response.into_body(), 1 << 20)
        .await
        .expect("body reads");
    String::from_utf8_lossy(&bytes).into_owned()
}

#[tokio::test]
async fn shell_renders_the_sidebar_and_reading_pane() {
    let response = get(&config(), "/").await;
    assert_eq!(response.status(), StatusCode::OK);
    let html = body_text(response).await;

    assert!(html.contains("<aside class=\"sidebar\">"), "no sidebar");
    assert!(html.contains("id=\"reading-pane\""), "no reading pane");
    assert!(html.contains("id=\"note-pane\""), "no swap target");
    // htmx 4 inherits only attributes suffixed with `:inherited`.
    assert!(
        html.contains("hx-boost:inherited=\"true\""),
        "navigation not boosted"
    );
    assert!(
        html.contains("hx-target:inherited=\"#note-pane\""),
        "boost target not declared"
    );
    assert!(html.contains("notes"), "vault label missing");
    // The status-bar strip iOS needs before it stops blurring the app's top
    // edge; hidden by CSS everywhere except an installed phone app.
    assert!(
        html.contains("<div class=\"status-bar-backdrop\" aria-hidden=\"true\"></div>"),
        "no iOS status-bar strip"
    );
}

#[tokio::test]
async fn shell_links_home_from_the_vault_name_and_to_published_pages() {
    let html = body_text(get(&config(), "/").await).await;
    assert!(
        html.contains("<a class=\"vault-name\" href=\"/\">notes</a>"),
        "the vault name is not a link home"
    );
    assert!(
        html.contains("class=\"box-link\" href=\"/s/\" hx-boost=\"false\""),
        "no published-pages box"
    );
    assert!(
        html.contains("id=\"attach-dialog\""),
        "no attachment dialog"
    );
    assert!(html.contains("attach-dialog-download"));
}

#[tokio::test]
async fn htmx_requests_get_the_pane_and_history_restores_get_the_page() {
    let root = temp_vault();
    std::fs::write(root.join("alpha.md"), b"# hello").unwrap();
    let config = vault_config(&root);

    let fragment = get_with(&config, "/notes/alpha.md", &[("hx-request", "true")]).await;
    assert_eq!(fragment.status(), StatusCode::OK);
    let html = body_text(fragment).await;
    assert!(html.contains("<h1 class=\"note-title\">alpha</h1>"));
    assert!(
        !html.contains("<html"),
        "a fragment must not be a whole page"
    );
    assert!(!html.contains("id=\"reading-pane\""));
    assert!(
        !html.contains("status-bar-backdrop"),
        "a fragment must not carry the shell's status-bar strip"
    );

    let restore = get_with(
        &config,
        "/notes/alpha.md",
        &[
            ("hx-request", "true"),
            ("hx-history-restore-request", "true"),
        ],
    )
    .await;
    assert!(
        body_text(restore).await.contains("<html"),
        "history restore needs the whole page"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn search_answers_htmx_with_rows_and_a_plain_get_with_the_page() {
    let root = temp_vault();
    std::fs::write(root.join("alpha.md"), b"hello").unwrap();
    let config = vault_config(&root);

    let rows =
        body_text(get_with(&config, "/search?q=alpha", &[("hx-request", "true")]).await).await;
    assert!(rows.contains("href=\"/notes/alpha.md\""));
    assert!(!rows.contains("<html"), "the tree fragment is rows only");

    let page = body_text(get(&config, "/search?q=alpha").await).await;
    assert!(page.contains("<html"), "a plain GET is a whole page");
    assert!(page.contains("href=\"/notes/alpha.md\""));
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn attachment_requests_from_htmx_redirect_instead_of_swapping_bytes() {
    let root = temp_vault();
    std::fs::write(root.join("data.csv"), b"a,b\n").unwrap();
    let config = vault_config(&root);

    let response = get_with(&config, "/notes/data.csv", &[("hx-request", "true")]).await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        response
            .headers()
            .get("hx-redirect")
            .map(|v| v.to_str().unwrap()),
        Some("/notes/data.csv")
    );

    let plain = get(&config, "/notes/data.csv").await;
    assert_eq!(
        plain.headers().get(header::CONTENT_DISPOSITION).unwrap(),
        "attachment"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn mobile_sidebar_toggle_is_outside_the_hidden_sidebar() {
    let html = body_text(get(&config(), "/").await).await;
    assert!(
        html.contains("class=\"sidebar-toggle\""),
        "toggle is missing"
    );
    let sidebar_start = html
        .find("<aside class=\"sidebar\">")
        .expect("sidebar starts");
    let sidebar_end = html[sidebar_start..]
        .find("</aside>")
        .map(|offset| sidebar_start + offset)
        .expect("sidebar ends");
    assert!(
        !html[sidebar_start..sidebar_end].contains("sidebar-toggle"),
        "toggle must remain reachable when the sidebar is hidden"
    );
}

#[tokio::test]
async fn shell_references_only_local_assets() {
    let html = body_text(get(&config(), "/").await).await;
    // Versioned URLs: the fingerprint is what stops a CDN or browser from
    // serving the previous stylesheet or script after a deploy.
    for local in [
        "/static/css/app.css?v=",
        "/static/js/htmx.min.js?v=",
        "/static/js/app.js?v=",
    ] {
        assert!(html.contains(local), "{local} not linked with a version");
    }
    // The SSE extension and hyperscript were never used; nothing may load them.
    for gone in ["hx-sse", "_hyperscript"] {
        assert!(!html.contains(gone), "{gone} is no longer vendored");
    }
    // Vendored and served locally: the page must never reach a third party.
    for remote in ["http://", "https://", "//cdn", "unpkg", "npm"] {
        assert!(!html.contains(remote), "shell references {remote}");
    }
    // The icon set is declared here and served locally (the SVG for modern
    // browsers, the ICO for the rest, the PNGs for the sizes a browser may
    // prefer, the 180px PNG for iOS). These are the declared URLs, so they are
    // the fingerprinted, immutably cached ones — an unchanged apple-touch-icon
    // URL is what iOS would otherwise keep serving from its own cache.
    for icon in [
        "<link rel=\"icon\" href=\"/static/icons/favicon.svg?v=",
        "<link rel=\"icon\" href=\"/static/icons/favicon.ico?v=",
        "<link rel=\"icon\" href=\"/static/icons/favicon-32x32.png?v=",
        "<link rel=\"icon\" href=\"/static/icons/favicon-16x16.png?v=",
        "<link rel=\"apple-touch-icon\" href=\"/static/icons/apple-touch-icon.png?v=",
    ] {
        assert!(html.contains(icon), "head is missing {icon}");
    }
    // Installed on a phone: the manifest supplies the home-screen icon, and
    // `display: standalone` in it is what opens the app without browser chrome.
    assert!(html.contains("<link rel=\"manifest\" href=\"/site.webmanifest?v="));
    assert!(html.contains("<meta name=\"apple-mobile-web-app-capable\" content=\"yes\" />"));
    assert!(html.contains("<meta name=\"apple-mobile-web-app-title\" content=\"notes\" />"));
    assert!(html.contains("<meta name=\"theme-color\" content=\"#1e1e1e\" />"));
}

#[tokio::test]
async fn icons_are_served_at_the_root_paths_their_clients_ask_for() {
    for (uri, expected) in [
        ("/favicon.ico", "image/x-icon"),
        ("/favicon.svg", "image/svg+xml"),
        ("/favicon-16x16.png", "image/png"),
        ("/favicon-32x32.png", "image/png"),
        ("/apple-touch-icon.png", "image/png"),
        ("/icon-192.png", "image/png"),
        ("/icon-512.png", "image/png"),
    ] {
        let response = get(&config(), uri).await;
        assert_eq!(response.status(), StatusCode::OK, "{uri} not served");
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            Some(expected),
            "{uri} served with the wrong type"
        );
        // This is the copy for clients that never read the HTML, so it cannot
        // carry the asset fingerprint and gets an hour rather than a year.
        assert_eq!(
            response
                .headers()
                .get(header::CACHE_CONTROL)
                .and_then(|value| value.to_str().ok()),
            Some("public, max-age=3600"),
            "{uri} cached wrongly"
        );
    }
    // Nothing else is readable through that route, not even a real icon file
    // under another name.
    let response = get(&config(), "/icons/favicon.ico").await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    // The copy the pages actually declare is the fingerprinted one under
    // /static, cached for a year like every other asset.
    let html = body_text(get(&config(), "/").await).await;
    let version = html
        .split("/static/icons/favicon.svg?v=")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .expect("the head declares a fingerprinted favicon")
        .to_string();
    assert!(!version.is_empty());
    for (path, expected) in [
        ("/static/icons/favicon.ico", "image/x-icon"),
        ("/static/icons/favicon.svg", "image/svg+xml"),
        ("/static/icons/favicon-16x16.png", "image/png"),
        ("/static/icons/favicon-32x32.png", "image/png"),
        ("/static/icons/apple-touch-icon.png", "image/png"),
        ("/static/icons/icon-192.png", "image/png"),
        ("/static/icons/icon-512.png", "image/png"),
    ] {
        let uri = format!("{path}?v={version}");
        let response = get(&config(), &uri).await;
        assert_eq!(response.status(), StatusCode::OK, "{uri} not served");
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            Some(expected),
            "{uri} served with the wrong type"
        );
        assert_eq!(
            response
                .headers()
                .get(header::CACHE_CONTROL)
                .and_then(|value| value.to_str().ok()),
            Some("public, max-age=31536000, immutable"),
            "{uri} is not cached immutably"
        );
    }
}

#[tokio::test]
async fn the_manifest_names_the_app_and_its_icons() {
    let response = get(&config(), "/site.webmanifest").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
        Some("application/manifest+json")
    );
    let json: serde_json::Value =
        serde_json::from_str(&body_text(response).await).expect("the manifest parses as JSON");
    assert_eq!(json["name"], "notes — admin");
    assert_eq!(json["short_name"], "notes");
    assert_eq!(json["start_url"], "/");
    assert_eq!(json["scope"], "/");
    // What makes an installed app open without browser chrome.
    assert_eq!(json["display"], "standalone");
    assert_eq!(json["theme_color"], "#1e1e1e");
    assert_eq!(json["background_color"], "#1e1e1e");

    let icons = json["icons"].as_array().expect("icons array");
    assert_eq!(icons.len(), 2);
    for (size, path) in [
        ("192x192", "/static/icons/icon-192.png"),
        ("512x512", "/static/icons/icon-512.png"),
    ] {
        let icon = icons
            .iter()
            .find(|icon| icon["sizes"] == size)
            .unwrap_or_else(|| panic!("no {size} icon"));
        assert_eq!(icon["type"], "image/png");
        // The mark sits inside the maskable safe circle, so one file per size
        // serves both purposes.
        assert_eq!(icon["purpose"], "any maskable");
        // The src is the fingerprinted URL — what a browser re-reads the
        // manifest to learn, so a replaced icon is not a year-old cached one —
        // and the file it names is really served.
        let src = icon["src"].as_str().expect("src is a string");
        let (named, version) = src.split_once("?v=").expect("src carries the fingerprint");
        assert_eq!(named, path);
        assert!(!version.is_empty());
        assert_eq!(get(&config(), src).await.status(), StatusCode::OK);
    }

    // The vault's name is a filesystem name, not trusted JSON.
    let root = temp_vault().join("odd\"name\\vault");
    std::fs::create_dir_all(&root).unwrap();
    let body = body_text(get(&vault_config(&root), "/site.webmanifest").await).await;
    let json: serde_json::Value =
        serde_json::from_str(&body).unwrap_or_else(|e| panic!("{e} in {body}"));
    assert_eq!(json["short_name"], "odd\"name\\vault");
}

#[tokio::test]
async fn published_pages_carry_the_same_icon_set() {
    let root = temp_vault();
    std::fs::create_dir_all(root.join("demo")).unwrap();
    std::fs::write(root.join("demo/index.html"), "<p>hi</p>").unwrap();
    let mut config = config();
    config.published_root = root;
    let html = body_text(get(&config, "/s/").await).await;
    assert!(
        html.contains(
            "<link rel=\"apple-touch-icon\" href=\"/static/icons/apple-touch-icon.png?v="
        )
    );
    assert!(html.contains("<link rel=\"manifest\" href=\"/site.webmanifest?v="));
    assert!(html.contains("<meta name=\"apple-mobile-web-app-title\" content=\"notes\" />"));
}

#[tokio::test]
async fn health_answers_ok() {
    let response = get(&config(), "/health").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body_text(response).await, "ok");
}

#[tokio::test]
async fn static_assets_are_served_immutably() {
    let response = get(&config(), "/static/css/app.css?v=fingerprint").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get(header::CACHE_CONTROL)
            .and_then(|value| value.to_str().ok()),
        Some("public, max-age=31536000, immutable")
    );
}

#[tokio::test]
async fn static_assets_are_served_with_their_content_types() {
    for (uri, expected) in [
        ("/static/css/app.css", "css"),
        ("/static/js/htmx.min.js", "javascript"),
        ("/static/js/app.js", "javascript"),
    ] {
        let response = get(&config(), uri).await;
        assert_eq!(response.status(), StatusCode::OK, "{uri} not served");
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        assert!(
            content_type.contains(expected),
            "{uri} served as {content_type:?}, expected {expected}"
        );
    }
}

#[tokio::test]
async fn unknown_paths_are_not_found() {
    let response = get(&config(), "/nope").await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn note_and_download_routes_reject_encoded_traversal_and_absolute_paths() {
    let root = temp_vault();
    let outside = root.with_extension("outside");
    std::fs::write(&outside, b"secret outside content").unwrap();
    let config = vault_config(&root);
    for route in [
        "/notes/%2e%2e%2foutside",
        "/download/notes/%2e%2e%2foutside",
        "/notes/%2fetc%2fpasswd",
        "/download/notes/%2fetc%2fpasswd",
    ] {
        let response = get(&config, route).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{route}");
        assert!(!body_text(response).await.contains("secret outside content"));
    }
    let _ = std::fs::remove_file(outside);
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn note_and_download_routes_reject_symlinks_outside_root() {
    use std::os::unix::fs::symlink;
    let root = temp_vault();
    let outside = root.with_extension("outside");
    std::fs::write(&outside, b"secret symlink content").unwrap();
    symlink(&outside, root.join("escape.md")).unwrap();
    let config = vault_config(&root);
    for route in ["/notes/escape.md", "/download/notes/escape.md"] {
        let response = get(&config, route).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{route}");
        assert!(!body_text(response).await.contains("secret symlink content"));
    }
    let _ = std::fs::remove_file(outside);
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn empty_note_renders_without_panicking() {
    let root = temp_vault();
    std::fs::write(root.join("empty.md"), b"").unwrap();
    let response = get(&vault_config(&root), "/notes/empty.md").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        body_text(response)
            .await
            .contains("class=\"note-title\">empty</h1>")
    );
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn oversized_note_offers_download_not_inline_content() {
    let root = temp_vault();
    std::fs::write(root.join("large.md"), vec![b'x'; 1_048_577]).unwrap();
    let response = get(&vault_config(&root), "/notes/large.md").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers().get(header::CONTENT_DISPOSITION), None);
    let html = body_text(response).await;
    assert!(html.contains("File exceeds the 1 MiB inline limit."));
    assert!(html.contains("/download/notes/large.md"));
    assert!(!html.contains(&"x".repeat(100)));
    let download = get(&vault_config(&root), "/download/notes/large.md").await;
    assert_eq!(
        download.headers().get(header::CONTENT_DISPOSITION).unwrap(),
        "attachment"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn attachments_use_inline_images_and_download_unknown_types() {
    let root = temp_vault();
    std::fs::write(root.join("image.png"), b"png").unwrap();
    std::fs::write(root.join("file.bin"), b"binary").unwrap();
    let config = vault_config(&root);
    let image = get(&config, "/notes/image.png").await;
    assert_eq!(
        image.headers().get(header::CONTENT_TYPE).unwrap(),
        "image/png"
    );
    assert_eq!(image.headers().get(header::CONTENT_DISPOSITION), None);
    let unknown = get(&config, "/notes/file.bin").await;
    assert_eq!(
        unknown.headers().get(header::CONTENT_TYPE).unwrap(),
        "application/octet-stream"
    );
    assert_eq!(
        unknown.headers().get(header::CONTENT_DISPOSITION).unwrap(),
        "attachment"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn search_result_link_opens_matching_note() {
    let root = temp_vault();
    std::fs::write(root.join("alpha.md"), b"hello").unwrap();
    let config = vault_config(&root);
    let search = body_text(get(&config, "/search?q=alpha").await).await;
    assert!(search.contains("href=\"/notes/alpha.md\""));
    assert_eq!(
        get(&config, "/notes/alpha.md").await.status(),
        StatusCode::OK
    );
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn a_missing_notes_root_still_boots() {
    let config = Config::from_lookup(|key| {
        (key == "NOTES_DIR").then(|| "/nonexistent/notes-root-for-tests".to_string())
    });
    assert_eq!(
        config.boot_warnings().len(),
        1,
        "a missing notes root must warn"
    );
    assert_eq!(get(&config, "/").await.status(), StatusCode::OK);
    assert_eq!(get(&config, "/health").await.status(), StatusCode::OK);
}
