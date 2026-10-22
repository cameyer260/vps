//! Static published-page index and root-confined file serving.

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
    let mut response = Response::new(Body::from(bytes));
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
