//! Static published-page index, root-confined file serving, and the back-arrow
//! navigation injected into every HTML document served from the published root.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use askama::Template;
use axum::Router;
use axum::body::Body;
use axum::extract::{Path as AxumPath, State};
use axum::http::{StatusCode, header};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::config::Config;

const MAX_SLUG_LENGTH: usize = 64;

/// The navigation every published HTML document is served with: a back arrow to
/// the index at the top left of the screen, styled after the notes page's
/// sidebar toggle so the two read as the same chrome.
///
/// Self-contained rather than a link to `app.css`: a published page brings its
/// own design, and Tailwind's preflight would rearrange it. The theme variables
/// are the site's, with the site's own values as fallbacks, so a page that
/// defines them gets the exact site look and one that does not still gets a
/// button that matches its neighbours.
///
/// `position: fixed` is what puts it in the viewport's top-left corner whatever
/// the markup's place in the document is, and keeps it out of the page's
/// layout; the offsets add the safe-area insets so a notch cannot eat it.
const PUBLISHED_NAV: &str = r#"<style>
.published-nav {
  position: fixed;
  z-index: 10;
  top: calc(8px + env(safe-area-inset-top, 0px));
  left: calc(8px + env(safe-area-inset-left, 0px));
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  min-width: 40px;
  min-height: 40px;
  margin: 0;
  border: 1px solid var(--background-modifier-border, #333333);
  border-radius: 5px;
  color: var(--text-normal, #dcddde);
  background: var(--background-secondary, #161616);
  font: 20px/1 var(--font-text, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif);
  text-decoration: none;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.published-nav:focus-visible {
  outline: 2px solid var(--text-accent, #7f6df2);
  outline-offset: 2px;
}
</style>
<a class="published-nav" href="/s/" aria-label="Back to published pages" title="Back to published pages"><span aria-hidden="true">←</span></a>
"#;

pub(crate) fn routes() -> Router<Arc<Config>> {
    Router::new()
        .route("/s/", get(index))
        .route("/s", get(index))
        .route("/s/{*path}", get(serve_path))
}

#[derive(Debug)]
struct PublishedPage {
    slug: String,
    /// Unix seconds (the directory's mtime), carried to the browser to render
    /// the time in the reader's own timezone.
    published: u64,
    /// The same instant as RFC 3339 UTC, for the `datetime` attribute.
    datetime: String,
    /// The instant spelled out, shown until `app.js` localizes it.
    fallback: String,
}

#[derive(Template)]
#[template(path = "publish.html")]
struct PublishIndex<'a> {
    pages: &'a [PublishedPage],
    asset_version: &'a str,
    /// Only for the head: the icon links, the manifest and the home-screen
    /// label, which the notes page carries too.
    vault_name: &'a str,
}

async fn index(State(config): State<Arc<Config>>) -> Html<String> {
    let mut pages = published_pages(&config.published_root);
    pages.sort_by(|a, b| {
        b.published
            .cmp(&a.published)
            .then_with(|| a.slug.cmp(&b.slug))
    });

    PublishIndex {
        pages: &pages,
        asset_version: &config.asset_version,
        vault_name: &config.vault_name(),
    }
    .render()
    .map(Html)
    .unwrap_or_else(|e| {
        log::error!("publish template failed: {e}");
        Html(String::new())
    })
}

fn published_pages(root: &Path) -> Vec<PublishedPage> {
    let Ok(root) = fs::canonicalize(root) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&root) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let slug = entry.file_name().into_string().ok()?;
            if !valid_slug(&slug) {
                return None;
            }
            let path = entry.path();
            let metadata = fs::metadata(&path).ok()?;
            if !metadata.is_dir() || !fs::canonicalize(&path).ok()?.starts_with(&root) {
                return None;
            }
            let published = metadata
                .modified()
                .ok()?
                .duration_since(UNIX_EPOCH)
                .ok()?
                .as_secs();
            let moment = OffsetDateTime::from_unix_timestamp(published as i64).ok()?;
            Some(PublishedPage {
                slug,
                published,
                datetime: moment.format(&Rfc3339).ok()?,
                fallback: format!(
                    "{:04}-{:02}-{:02} {:02}:{:02} UTC",
                    moment.year(),
                    moment.month() as u8,
                    moment.day(),
                    moment.hour(),
                    moment.minute()
                ),
            })
        })
        .collect()
}

async fn serve_path(
    State(config): State<Arc<Config>>,
    AxumPath(path): AxumPath<String>,
) -> Response {
    serve_file(config, path)
}

fn serve_file(config: Arc<Config>, path: String) -> Response {
    let path = path.trim_start_matches('/');
    let mut segments = path.split('/');
    let Some(slug) = segments.next() else {
        return not_found();
    };
    if !valid_slug(slug) {
        return not_found();
    }

    let mut relative = PathBuf::from(slug);
    let rest: Vec<&str> = segments.collect();
    if rest.iter().any(|segment| segment.is_empty()) {
        // A trailing slash names a directory URL; interior empty components are not paths.
        if rest.iter().filter(|segment| segment.is_empty()).count() > 1 {
            return not_found();
        }
    }
    for segment in rest.iter().filter(|segment| !segment.is_empty()) {
        let component = Path::new(segment);
        if component
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        {
            return not_found();
        }
        relative.push(component);
    }
    if rest.last().is_none_or(|segment| segment.is_empty()) {
        relative.push("index.html");
    }

    let Ok(root) = fs::canonicalize(&config.published_root) else {
        return not_found();
    };
    let candidate = root.join(relative);
    let Ok(resolved) = fs::canonicalize(candidate) else {
        return not_found();
    };
    if !resolved.starts_with(&root) {
        return not_found();
    }
    let Ok(metadata) = fs::metadata(&resolved) else {
        return not_found();
    };
    if !metadata.is_file() {
        return not_found();
    }
    let Ok(bytes) = fs::read(&resolved) else {
        return not_found();
    };
    let content_type = content_type(&resolved);
    // A published page is the one place every HTML document passes through, so
    // the back arrow to the index is added here rather than written into each
    // page. Files that are not documents — fragments, scripts, stylesheets,
    // images — are served exactly as they are on disk.
    let body = if content_type.starts_with("text/html") {
        inject_nav(&bytes).unwrap_or(bytes)
    } else {
        bytes
    };
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        content_type.parse().expect("static MIME type is valid"),
    );
    response
}

fn valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= MAX_SLUG_LENGTH
        && (slug.as_bytes()[0].is_ascii_lowercase() || slug.as_bytes()[0].is_ascii_digit())
        && slug
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "txt" => "text/plain; charset=utf-8",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "not found").into_response()
}

/// Insert the published-page navigation into an HTML document.
///
/// `None` — serve the bytes untouched — for anything that is not a whole HTML
/// document: a fragment, a file in another encoding, or an `.html` name on
/// something that is really a script or a stylesheet.
fn inject_nav(bytes: &[u8]) -> Option<Vec<u8>> {
    let html = std::str::from_utf8(bytes).ok()?;
    if !is_document(html) {
        return None;
    }
    // Immediately after the `<body …>` tag, where the button is a direct child
    // of the body: `position: fixed` is measured against the viewport unless an
    // ancestor has a `transform`, a `filter` or `contain: paint`, and a direct
    // child has no ancestor in between. A document without a body tag
    // (`<!doctype html><main>…`) gets it before `</html>` instead — the same top
    // level of the implied body.
    let at = find_tag_end(html, "body")
        .or_else(|| find_ci(html, "</html>"))
        .unwrap_or(html.len());
    let mut injected = String::with_capacity(html.len() + PUBLISHED_NAV.len());
    injected.push_str(&html[..at]);
    injected.push_str(PUBLISHED_NAV);
    injected.push_str(&html[at..]);
    Some(injected.into_bytes())
}

/// Whether an HTML source is a whole document rather than a fragment: it
/// carries a doctype or one of the document-level tags. Fragments are published
/// artifacts too — a partial a prototype fetches itself — and are served
/// untouched.
fn is_document(html: &str) -> bool {
    find_ci(html, "<!doctype").is_some()
        || ["html", "head", "body"]
            .iter()
            .any(|name| find_tag_end(html, name).is_some())
}

/// The offset just past the `>` of a `<name …>` start tag, or `None`. Tag names
/// are compared the way HTML compares them, case-insensitively, and have to end
/// at the tag's delimiter, so that `<header>` is not read as `<head>`.
fn find_tag_end(html: &str, name: &str) -> Option<usize> {
    let bytes = html.as_bytes();
    let opening = format!("<{name}");
    let mut from = 0;
    while let Some(offset) = find_ci(&html[from..], &opening) {
        let after = from + offset + opening.len();
        match bytes.get(after) {
            Some(b'>') => return Some(after + 1),
            Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r') | Some(b'/') => {
                return html[after..].find('>').map(|end| after + end + 1);
            }
            _ => from = after,
        }
    }
    None
}

/// Case-insensitive substring search, the way HTML treats tag names.
fn find_ci(haystack: &str, needle: &str) -> Option<usize> {
    haystack
        .as_bytes()
        .windows(needle.len())
        .position(|window| window.eq_ignore_ascii_case(needle.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::inject_nav;

    fn injected(source: &str) -> String {
        String::from_utf8(inject_nav(source.as_bytes()).expect("a document gets the navigation"))
            .unwrap()
    }

    #[test]
    fn the_navigation_lands_right_after_the_body_tag() {
        let source = "<!doctype html>\n<html>\n<body class=\"page\">\n<main>content</main>\n</body>\n</html>\n";
        let out = injected(source);
        assert!(out.contains("href=\"/s/\""), "{out}");
        assert!(
            out.contains("aria-label=\"Back to published pages\""),
            "{out}"
        );
        assert!(
            out.contains("<main>content</main>"),
            "the page itself changed"
        );
        let nav = out.find("class=\"published-nav\"").unwrap();
        let body = out.find("<body class=\"page\">").unwrap();
        let main = out.find("<main>").unwrap();
        assert!(
            body < nav && nav < main,
            "the navigation is not a body child"
        );
    }

    #[test]
    fn a_document_without_a_body_tag_gets_the_navigation_at_the_end() {
        let source = "<!doctype html>\n<meta charset=\"utf-8\">\n<main>orbit</main>\n";
        let out = injected(source);
        assert!(out.starts_with(source), "the page itself changed");
        assert!(out.ends_with("</a>\n"), "{out}");
        assert!(out.contains("href=\"/s/\""));
    }

    #[test]
    fn tag_names_are_matched_case_insensitively_and_only_whole() {
        assert!(injected("<HTML>\n<BODY>\n<p>x</p>\n</BODY>\n</HTML>").contains("<BODY>"));
        // `<header>` is not `<head>`: an HTML fragment stays a fragment.
        assert!(inject_nav(b"<header>only a partial</header>").is_none());
    }

    #[test]
    fn fragments_and_non_utf8_are_served_untouched() {
        assert!(inject_nav(b"<div>a fragment an htmx swap would use</div>").is_none());
        assert!(inject_nav(b"\xff\xfe<html>not utf-8</html>").is_none());
    }

    #[test]
    fn exactly_one_link_is_injected() {
        let out = injected("<html><body></body></html>");
        assert_eq!(out.matches("href=\"/s/\"").count(), 1, "{out}");
        assert!(out.contains(".published-nav {"), "the button has no styles");
    }
}
