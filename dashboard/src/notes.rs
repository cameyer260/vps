//! Read-only notes tree, filename search, confined file serving, and attachments.
use crate::{config::Config, render};
use askama::Template;
use axum::{
    body::Body,
    extract::{Path as AxumPath, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{Html, IntoResponse, Response},
};
use serde::Deserialize;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

#[derive(Template)]
#[template(path = "notes.html")]
struct NotesPage<'a> {
    vault_name: &'a str,
    notes_root: &'a str,
    tree: &'a str,
    pane: &'a str,
    asset_version: &'a str,
}

fn escaped(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
fn url_path(s: &str) -> String {
    s.split('/')
        .map(|part| {
            part.bytes()
                .map(|b| {
                    if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                        (b as char).to_string()
                    } else {
                        format!("%{b:02X}")
                    }
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("/")
}
fn visible(path: &Path) -> bool {
    !path
        .components()
        .any(|part| part.as_os_str().to_string_lossy().starts_with('.'))
}
fn collect(root: &Path) -> Vec<String> {
    fn walk(root: &Path, dir: &Path, files: &mut Vec<String>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name().to_string_lossy().to_lowercase());
        for entry in entries {
            let path = entry.path();
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.')
                || !visible(path.strip_prefix(root).unwrap_or(&path))
            {
                continue;
            }
            let Ok(real) = fs::canonicalize(&path) else {
                continue;
            };
            let Ok(real_root) = fs::canonicalize(root) else {
                continue;
            };
            if !real.starts_with(real_root) {
                continue;
            }
            if real.is_dir() {
                walk(root, &path, files);
            } else if real
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("md"))
                && let Ok(rel) = path.strip_prefix(root)
            {
                files.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    let mut result = Vec::new();
    walk(root, root, &mut result);
    result.sort_by_key(|s| s.to_lowercase());
    result
}
fn tree(root: &Path, active: &str, query: Option<&str>) -> String {
    // The filter box is never swapped, so typing keeps focus and text; only the
    // rows below it are replaced. The form's action is the no-JS path.
    let mut out = String::from(
        "<nav class=\"tree\" id=\"tree\" aria-label=\"Notes\"><form class=\"tree-filter\" action=\"/search\" method=\"get\" hx-boost=\"false\" hx-get=\"/search\" hx-target=\"#tree-list\" hx-swap=\"innerHTML\"><input name=\"q\" type=\"search\" placeholder=\"Filter notes\" value=\"",
    );
    if let Some(q) = query {
        out.push_str(&escaped(q));
    }
    out.push_str(
        "\" hx-get=\"/search\" hx-target=\"#tree-list\" hx-swap=\"innerHTML\" hx-trigger=\"input changed delay:250ms\"></form><div class=\"tree-list\" id=\"tree-list\">",
    );
    out.push_str(&tree_list(root, active, query));
    out.push_str("</div></nav>");
    out
}

/// The rows inside the tree: nested folders and files, or a flat filtered list.
fn tree_list(root: &Path, active: &str, query: Option<&str>) -> String {
    let files = collect(root);
    let mut out = String::new();
    if let Some(q) = query.filter(|q| !q.is_empty()) {
        let q = q.to_lowercase();
        let mut found = false;
        for file in files.iter().filter(|f| f.to_lowercase().contains(&q)) {
            found = true;
            out.push_str(&file_row(file, file == active));
        }
        if !found {
            out.push_str("<p class=\"tree-empty\">No matching notes.</p>");
        }
    } else {
        // Folders are emitted before notes; each folder's notes remain grouped and expandable.
        tree_level(root, root, active, &mut out);
        if files.is_empty() {
            out.push_str("<p class=\"tree-empty\">No notes yet.</p>");
        }
    }
    out
}

/// One file row. Non-markdown files carry what the attachment dialog needs:
/// the type for its message and the download route for its button.
fn file_row(rel: &str, active: bool) -> String {
    let name = Path::new(rel)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy();
    let class = if active {
        "tree-file tree-row active"
    } else {
        "tree-file tree-row"
    };
    let href = url_path(rel);
    if Path::new(rel)
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("md"))
    {
        format!(
            "<a class=\"{class}\" href=\"/notes/{href}\"><span class=\"tree-name\">{}</span></a>",
            escaped(&name)
        )
    } else {
        let kind = Path::new(rel)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_uppercase())
            .unwrap_or_default();
        let inline = if opens_inline(Path::new(rel)) {
            " data-inline=\"true\""
        } else {
            ""
        };
        format!(
            "<a class=\"{class} attachment\" href=\"/notes/{href}\" data-type=\"{}\"{inline} data-download=\"/download/notes/{href}\" hx-boost=\"false\"><span class=\"tree-name\">{}</span></a>",
            escaped(&kind),
            escaped(&name)
        )
    }
}
fn tree_level(root: &Path, dir: &Path, active: &str, out: &mut String) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for e in rd.flatten() {
        let p = e.path();
        let n = e.file_name();
        if n.to_string_lossy().starts_with('.') {
            continue;
        }
        let Ok(root_real) = fs::canonicalize(root) else {
            continue;
        };
        let Ok(path_real) = fs::canonicalize(&p) else {
            continue;
        };
        if !path_real.starts_with(root_real) {
            continue;
        }
        if path_real.is_dir() {
            dirs.push((n, p))
        } else {
            files.push((n, p))
        }
    }
    let order = |a: &(std::ffi::OsString, PathBuf), b: &(std::ffi::OsString, PathBuf)| {
        a.0.to_string_lossy()
            .to_lowercase()
            .cmp(&b.0.to_string_lossy().to_lowercase())
    };
    dirs.sort_by(order);
    files.sort_by(order);
    for (name, path) in dirs {
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        let rel = rel.to_string_lossy().replace('\\', "/");
        // The chevron rotates on open; the children's left border is the guide
        // line that drops from it (Obsidian's file explorer).
        out.push_str(&format!(
            "<details class=\"tree-folder\"{}><summary class=\"tree-row\"><span class=\"chev\" aria-hidden=\"true\"></span><span class=\"tree-name\">{}</span></summary><div class=\"tree-children\">",
            if active.starts_with(&(rel.clone() + "/")) {
                " open"
            } else {
                ""
            },
            escaped(&name.to_string_lossy())
        ));
        tree_level(root, &path, active, out);
        out.push_str("</div></details>");
    }
    for (_name, path) in files {
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        let rel = rel.to_string_lossy().replace('\\', "/");
        out.push_str(&file_row(&rel, active == rel));
    }
}
fn page(c: &Config, active: &str, pane: &str, query: Option<&str>) -> String {
    NotesPage {
        vault_name: &c.vault_name(),
        notes_root: &c.notes_root.display().to_string(),
        tree: &tree(&c.notes_root, active, query),
        pane,
        asset_version: &c.asset_version,
    }
    .render()
    .unwrap_or_else(|e| {
        log::error!("notes template failed: {e}");
        String::new()
    })
}
/// The reading pane with no note open.
const HOME_PANE: &str =
    "<h1 class=\"note-title\">Notes</h1><p class=\"note-empty\">Pick a note to read it here.</p>";

/// True when htmx sent the request, so a fragment is an acceptable response.
fn htmx(headers: &HeaderMap) -> bool {
    headers.get("hx-request").is_some_and(|v| v == "true")
}

/// True when htmx is rebuilding the page from a history entry: that needs the
/// whole document, not a fragment.
fn history_restore(headers: &HeaderMap) -> bool {
    headers
        .get("hx-history-restore-request")
        .is_some_and(|v| v == "true")
}

/// htmx navigation swaps the reading pane, so the pane's contents are enough.
fn wants_fragment(headers: &HeaderMap) -> bool {
    htmx(headers) && !history_restore(headers)
}

/// The reading pane's contents, as a full page or as an htmx fragment.
fn pane_response(c: &Config, active: &str, pane: &str, headers: &HeaderMap) -> Response {
    if wants_fragment(headers) {
        Html(pane.to_string()).into_response()
    } else {
        Html(page(c, active, pane, None)).into_response()
    }
}

/// htmx cannot swap a file. Send the browser to the path so it opens or
/// downloads it as it would on a plain navigation (no content is swapped).
fn redirect_response(location: &str) -> Response {
    let mut r = Response::new(Body::empty());
    *r.status_mut() = StatusCode::NO_CONTENT;
    r.headers_mut().insert(
        header::HeaderName::from_static("hx-redirect"),
        location.parse().expect("a site path is a header value"),
    );
    r
}

pub async fn home(State(c): State<Arc<Config>>, headers: HeaderMap) -> Response {
    pane_response(&c, "", HOME_PANE, &headers)
}
#[derive(Deserialize)]
pub struct SearchQuery {
    q: Option<String>,
}
pub async fn search(
    State(c): State<Arc<Config>>,
    Query(q): Query<SearchQuery>,
    headers: HeaderMap,
) -> Response {
    let q = q.q.unwrap_or_default();
    if wants_fragment(&headers) {
        Html(tree_list(&c.notes_root, "", Some(&q))).into_response()
    } else {
        Html(page(&c, "", HOME_PANE, Some(&q))).into_response()
    }
}
fn confined(root: &Path, raw: &str) -> Option<PathBuf> {
    if raw.is_empty()
        || raw.starts_with('/')
        || raw
            .split('/')
            .any(|s| s == ".." || s.is_empty() || s == ".")
    {
        return None;
    }
    let rel = Path::new(raw);
    if !visible(rel) {
        return None;
    }
    let root = fs::canonicalize(root).ok()?;
    let real = fs::canonicalize(root.join(rel)).ok()?;
    if real.starts_with(&root) && real.is_file() {
        Some(real)
    } else {
        None
    }
}
fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}
/// Types the browser shows as they are. Everything else downloads, and the
/// tree asks before going there. One list drives both the row's `data-inline`
/// and the response's disposition, so the dialog can never promise a download
/// the route would serve inline, or vice versa.
fn opens_inline(path: &Path) -> bool {
    matches!(
        content_type(path),
        "application/pdf" | "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    )
}
fn file_response(path: &Path, download: bool) -> Response {
    let Ok(bytes) = fs::read(path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut r = Response::new(bytes.into());
    *r.status_mut() = StatusCode::OK;
    r.headers_mut()
        .insert(header::CONTENT_TYPE, content_type(path).parse().unwrap());
    if download || !opens_inline(path) {
        r.headers_mut()
            .insert(header::CONTENT_DISPOSITION, "attachment".parse().unwrap());
    }
    r
}
pub async fn download(State(c): State<Arc<Config>>, AxumPath(path): AxumPath<String>) -> Response {
    let Some(real) = confined(&c.notes_root, &path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    file_response(&real, true)
}
pub async fn note(
    State(c): State<Arc<Config>>,
    AxumPath(path): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    let Some(real) = confined(&c.notes_root, &path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(meta) = fs::metadata(&real) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let name = escaped(
        &Path::new(&path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy(),
    );
    if meta.len() > render::MAX_INLINE_BYTES {
        let pane = format!(
            "<h1 class=\"note-title\">{name}</h1><p>File exceeds the 1 MiB inline limit.</p><a href=\"/download/notes/{}\">Download</a>",
            url_path(&path)
        );
        return pane_response(&c, &path, &pane, &headers);
    }
    if real
        .extension()
        .is_some_and(|e| !e.eq_ignore_ascii_case("md"))
    {
        if wants_fragment(&headers) {
            return redirect_response(&format!("/notes/{}", url_path(&path)));
        }
        return file_response(&real, false);
    }
    let bytes = match fs::read(&real) {
        Ok(b) => b,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    let source = String::from_utf8_lossy(&bytes);
    let (properties, body) = render::render(&source, &path, &c.notes_root);
    let name = escaped(
        &Path::new(&path)
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy(),
    );
    pane_response(
        &c,
        &path,
        &format!("<h1 class=\"note-title\">{name}</h1>{properties}{body}"),
        &headers,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        time::{SystemTime, UNIX_EPOCH},
    };
    struct Vault(PathBuf);
    impl Vault {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "notes-test-{}",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        fn put(&self, p: &str, b: &[u8]) {
            let f = self.0.join(p);
            fs::create_dir_all(f.parent().unwrap()).unwrap();
            fs::File::create(f).unwrap().write_all(b).unwrap();
        }
    }
    impl Drop for Vault {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn search_matches_paths_not_content_and_hides_dotfiles() {
        let v = Vault::new();
        v.put("Folder/alpha-note.md", b"secret phrase");
        v.put(".hidden.md", b"secret phrase");
        let all = collect(&v.0);
        assert!(all.iter().any(|p| p.contains("alpha")));
        assert!(all.iter().any(|p| p.contains("Folder")));
        assert!(!all.iter().any(|p| p.contains("hidden")));
        assert!(tree(&v.0, "", Some("alpha-note")).contains("alpha-note.md"));
        assert!(tree(&v.0, "", Some("Folder")).contains("alpha-note.md"));
        let results = tree(&v.0, "", Some("secret phrase"));
        assert!(results.contains("No matching notes"));
        assert!(tree(&v.0, "", Some("missing")).contains("No matching notes"));
    }
    #[test]
    fn confined_rejects_traversal_absolute_and_symlink_escape() {
        let v = Vault::new();
        v.put("ok.md", b"ok");
        assert!(confined(&v.0, "ok.md").is_some());
        assert!(confined(&v.0, "../outside").is_none());
        assert!(confined(&v.0, "/etc/passwd").is_none());
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let out = v.0.with_extension("outside");
            fs::write(&out, b"x").unwrap();
            symlink(&out, v.0.join("escape.md")).unwrap();
            symlink(v.0.join("ok.md"), v.0.join("CLAUDE.md")).unwrap();
            assert!(confined(&v.0, "escape.md").is_none());
            assert!(confined(&v.0, "CLAUDE.md").is_some());
            let _ = fs::remove_file(out);
        }
    }
    #[test]
    fn inline_limit_and_attachment_types_are_stable() {
        assert_eq!(render::MAX_INLINE_BYTES, 1_048_576);
        assert_eq!(content_type(Path::new("scan.pdf")), "application/pdf");
        assert_eq!(content_type(Path::new("screen.png")), "image/png");
        assert!(opens_inline(Path::new("scan.pdf")));
        assert!(opens_inline(Path::new("screen.PNG")));
        assert!(!opens_inline(Path::new("data.csv")));
        assert!(!opens_inline(Path::new("icon.svg")));
        assert!(!opens_inline(Path::new("readme.txt")));
        let lossy = String::from_utf8_lossy(&[0xff, b'x']);
        assert!(lossy.contains('�'));
    }

    #[test]
    fn tree_rows_are_obsidian_shaped_and_attachments_carry_their_data() {
        let v = Vault::new();
        v.put("Folder/note.md", b"x");
        v.put("Folder/data.csv", b"x");
        v.put("Folder/scan.pdf", b"x");
        v.put("top.md", b"x");
        let html = tree(&v.0, "Folder/note.md", None);
        assert!(html.contains("id=\"tree-list\""), "no fragment target");
        assert!(html.contains("hx-trigger=\"input changed delay:250ms\""));
        assert!(html.contains("<summary class=\"tree-row\"><span class=\"chev\""));
        assert!(html.contains("<div class=\"tree-children\">"));
        assert!(html.contains("<details class=\"tree-folder\" open>"));
        assert!(html.contains("<a class=\"tree-file tree-row\" href=\"/notes/top.md\""));
        assert!(html.contains("data-type=\"CSV\""));
        assert!(html.contains("data-download=\"/download/notes/Folder/data.csv\""));
        // The dialog only sits in front of files that would download; rows the
        // route serves inline say so, and markup and route share one list.
        let csv_row = html
            .split("<a ")
            .find(|row| row.contains("data.csv"))
            .expect("the CSV row is in the tree");
        assert!(!csv_row.contains("data-inline"));
        assert!(html.contains("data-type=\"PDF\" data-inline=\"true\""));
        assert!(html.contains("hx-boost=\"false\""));
        assert!(!html.contains('↳'), "the attachment marker is gone");
        // Filtered results are flat rows: no folders, and the empty state holds.
        // Search covers notes, so an attachment is not a result.
        let filtered = tree_list(&v.0, "", Some("note"));
        assert!(filtered.contains("Folder/note.md"));
        assert!(!filtered.contains("tree-folder"));
        assert!(!tree_list(&v.0, "", Some("data")).contains("data.csv"));
        assert!(tree_list(&v.0, "", Some("nothing-here")).contains("No matching notes."));
    }

    #[test]
    fn tree_hides_dot_dirs_and_empty_directory_is_safe() {
        let v = Vault::new();
        fs::create_dir(v.0.join("empty")).unwrap();
        v.put(".git/hidden.md", b"x");
        assert!(tree(&v.0, "", None).contains("No notes yet"));
        assert!(!tree(&v.0, "", None).contains("hidden.md"));
    }
}
