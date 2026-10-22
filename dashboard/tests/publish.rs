use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode, header};
use axum::response::Response;
use dashboard::config::Config;
use tower::ServiceExt;

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "dashboard-publish-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn config(&self) -> Config {
        let root = self.0.to_string_lossy().to_string();
        Config::from_lookup(|key| (key == "PUBLISHED_DIR").then(|| root.clone()))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

async fn get(config: &Config, uri: &str) -> Response {
    dashboard::app(config)
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap()
}
async fn text(response: Response) -> String {
    String::from_utf8(
        to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap()
}

#[tokio::test]
async fn fragments_and_sibling_assets_are_served_as_is_with_content_types() {
    let fixture = Fixture::new();
    let page = fixture.0.join("demo");
    fs::create_dir_all(&page).unwrap();
    // A fragment, not a document: the navigation is injected into documents
    // only, so this is served byte for byte.
    fs::write(page.join("index.html"), "<script>window.ran=true</script>").unwrap();
    fs::write(page.join("app.js"), "window.asset=true").unwrap();
    fs::write(page.join("style.css"), "body { color: red }").unwrap();

    let response = get(&fixture.config(), "/s/demo/").await;
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "{}",
        text(response).await
    );
    assert_eq!(
        text(get(&fixture.config(), "/s/demo/").await).await,
        "<script>window.ran=true</script>"
    );
    for (uri, expected) in [
        ("/s/demo/app.js", "text/javascript"),
        ("/s/demo/style.css", "text/css"),
    ] {
        let response = get(&fixture.config(), uri).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            response.headers()[header::CONTENT_TYPE]
                .to_str()
                .unwrap()
                .contains(expected)
        );
    }
}

#[tokio::test]
async fn index_lists_valid_directories_newest_first_and_missing_root_is_empty() {
    let fixture = Fixture::new();
    let config = fixture.config();
    assert!(
        text(get(&config, "/s/").await)
            .await
            .contains("No published pages yet")
    );
    fs::create_dir_all(fixture.0.join("older")).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(1100));
    fs::create_dir_all(fixture.0.join("newer")).unwrap();
    fs::write(fixture.0.join("not-a-slug"), "ignore").unwrap();
    let index = text(get(&config, "/s/").await).await;
    assert!(index.contains("/s/older/"));
    assert!(index.contains("/s/newer/"));
    assert!(!index.contains("not-a-slug"));
    assert!(index.find("/s/newer/").unwrap() < index.find("/s/older/").unwrap());
    fs::remove_dir_all(fixture.0.join("newer")).unwrap();
    let index = text(get(&config, "/s/").await).await;
    assert!(!index.contains("/s/newer/"));

    let missing = Config::from_lookup(|key| {
        (key == "PUBLISHED_DIR").then(|| fixture.0.join("missing").to_string_lossy().to_string())
    });
    assert!(
        text(get(&missing, "/s/").await)
            .await
            .contains("No published pages yet")
    );
}

#[tokio::test]
async fn index_uses_the_site_stylesheet_and_local_time_markup() {
    let fixture = Fixture::new();
    let page = fixture.0.join("demo");
    fs::create_dir_all(&page).unwrap();
    fs::write(page.join("index.html"), "page").unwrap();

    let body = text(get(&fixture.config(), "/s/").await).await;
    assert!(
        body.contains("/static/css/app.css?v="),
        "the index does not use the site stylesheet"
    );
    assert!(body.contains("<a class=\"box-link\" href=\"/\">Notes</a>"));
    assert!(body.contains("<a href=\"/s/demo/\">demo</a>"));
    assert!(body.contains("data-epoch="), "no epoch for local time");
    assert!(
        body.contains("datetime=\"20"),
        "no machine-readable datetime"
    );
    assert!(body.contains("UTC"), "no fallback text");
    assert!(
        body.contains("class=\"status-bar-backdrop\""),
        "the index is missing the iOS status-bar strip"
    );
    assert!(!body.contains("<style"), "inline styles are gone");
}

#[tokio::test]
async fn html_documents_are_served_with_the_back_link_to_the_index() {
    let fixture = Fixture::new();
    let page = fixture.0.join("demo");
    let sub = page.join("sub");
    fs::create_dir_all(&sub).unwrap();
    let document = "<!doctype html>\n<html>\n<head><title>demo</title></head>\n<body>\n<main>content marker</main>\n</body>\n</html>\n";
    fs::write(page.join("index.html"), document).unwrap();
    fs::write(sub.join("page.html"), document).unwrap();
    fs::write(page.join("fragment.html"), "<div>a fragment</div>").unwrap();

    for uri in ["/s/demo/", "/s/demo/sub/page.html"] {
        let body = text(get(&fixture.config(), uri).await).await;
        assert!(
            body.contains("href=\"/s/\""),
            "{uri} has no link back to the index"
        );
        assert!(
            body.contains("aria-label=\"Back to published pages\""),
            "{uri} has no accessible label"
        );
        assert!(
            body.contains("<main>content marker</main>"),
            "{uri} lost page content"
        );
        let nav = body.find("class=\"published-nav\"").expect("no navigation");
        assert!(
            body.find("<body>").unwrap() < nav && nav < body.find("<main>").unwrap(),
            "{uri} put the navigation somewhere other than the body's top"
        );
        assert_eq!(
            body.matches("href=\"/s/\"").count(),
            1,
            "{uri} has more than one link"
        );
    }

    assert_eq!(
        text(get(&fixture.config(), "/s/demo/fragment.html").await).await,
        "<div>a fragment</div>",
        "an HTML fragment was rewritten"
    );
}

#[tokio::test]
async fn a_document_without_a_body_tag_is_served_with_the_link_appended() {
    let fixture = Fixture::new();
    let page = fixture.0.join("minimal");
    fs::create_dir_all(&page).unwrap();
    let document = "<!doctype html>\n<meta charset=\"utf-8\">\n<main>orbit</main>\n";
    fs::write(page.join("index.html"), document).unwrap();

    let body = text(get(&fixture.config(), "/s/minimal/").await).await;
    assert!(
        body.starts_with(document),
        "the page itself changed: {body}"
    );
    assert!(body.contains("href=\"/s/\""), "no link back to the index");
}

#[tokio::test]
async fn a_non_utf8_html_document_is_served_byte_for_byte() {
    let fixture = Fixture::new();
    let page = fixture.0.join("latin1");
    fs::create_dir_all(&page).unwrap();
    let document: &[u8] = b"<html><body>\xe9</body></html>";
    fs::write(page.join("index.html"), document).unwrap();

    let body = to_bytes(
        get(&fixture.config(), "/s/latin1/").await.into_body(),
        1 << 20,
    )
    .await
    .unwrap();
    assert_eq!(
        body.to_vec(),
        document,
        "a non-UTF-8 document was rewritten"
    );
}

#[tokio::test]
async fn encoded_traversal_is_not_found_and_never_exposes_outside_files() {
    let fixture = Fixture::new();
    let page = fixture.0.join("demo");
    fs::create_dir_all(&page).unwrap();
    fs::write(page.join("index.html"), "page").unwrap();
    let outside = fixture.0.with_extension("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("secret.txt"), "outside-secret-content").unwrap();

    for uri in [
        "/s/demo/%2e%2e/%2e%2e/secret.txt",
        "/s/demo/%2e%2e%2f%2e%2e%2fsecret.txt",
        "/s/demo/%252e%252e/%252e%252e/secret.txt",
    ] {
        let response = get(&fixture.config(), uri).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{uri}");
        assert!(
            !text(response).await.contains("outside-secret-content"),
            "{uri} exposed the outside file"
        );
    }
    fs::remove_dir_all(outside).unwrap();
}

#[tokio::test]
async fn directory_without_index_is_not_found_or_listed() {
    let fixture = Fixture::new();
    let page = fixture.0.join("demo");
    fs::create_dir_all(&page).unwrap();
    fs::write(page.join("app.js"), "private asset marker").unwrap();

    let response = get(&fixture.config(), "/s/demo/").await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = text(response).await;
    assert!(!body.contains("app.js"));
    assert!(!body.contains("private asset marker"));
}

#[tokio::test]
async fn index_omits_invalid_entries_and_escaping_symlinks() {
    let fixture = Fixture::new();
    for name in ["Uppercase", "under_score", "-leading", &"a".repeat(65)] {
        fs::create_dir_all(fixture.0.join(name)).unwrap();
    }
    fs::create_dir_all(fixture.0.join("valid")).unwrap();
    fs::write(fixture.0.join("plain-file"), "not a directory").unwrap();
    let outside = fixture.0.with_extension("outside");
    fs::create_dir_all(&outside).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, fixture.0.join("escaping-link")).unwrap();

    let body = text(get(&fixture.config(), "/s/").await).await;
    assert!(body.contains("/s/valid/"));
    for invalid in [
        "Uppercase",
        "under_score",
        "-leading",
        &"a".repeat(65),
        "plain-file",
    ] {
        assert!(
            !body.contains(invalid),
            "index unexpectedly contains {invalid}"
        );
    }
    #[cfg(unix)]
    assert!(!body.contains("escaping-link"));
    fs::remove_dir_all(outside).unwrap();
}

#[tokio::test]
async fn slug_length_and_character_boundaries_are_enforced() {
    let fixture = Fixture::new();
    let one = "a";
    let max = "b".repeat(64);
    for slug in [one, &max] {
        let page = fixture.0.join(slug);
        fs::create_dir_all(&page).unwrap();
        fs::write(page.join("index.html"), format!("served-{slug}")).unwrap();
        assert_eq!(
            get(&fixture.config(), &format!("/s/{slug}/"))
                .await
                .status(),
            StatusCode::OK,
            "{slug}"
        );
    }
    for slug in [&"c".repeat(65), "Upper", "under_score"] {
        let page = fixture.0.join(slug);
        fs::create_dir_all(&page).unwrap();
        fs::write(page.join("index.html"), "must not serve").unwrap();
        assert_eq!(
            get(&fixture.config(), &format!("/s/{slug}/"))
                .await
                .status(),
            StatusCode::NOT_FOUND,
            "{slug}"
        );
    }

    let index = text(get(&fixture.config(), "/s/").await).await;
    assert!(index.contains("/s/a/"));
    assert!(index.contains(&format!("/s/{max}/")));
    for invalid in [&"c".repeat(65), "Upper", "under_score"] {
        assert!(!index.contains(invalid));
    }
}

#[tokio::test]
async fn invalid_slugs_traversal_directories_and_symlink_escapes_are_not_found() {
    let fixture = Fixture::new();
    let page = fixture.0.join("safe");
    fs::create_dir_all(&page).unwrap();
    fs::write(page.join("index.html"), "ok").unwrap();
    let too_long = format!("/s/{}/", "a".repeat(65));
    for uri in [
        "/s/Upper/",
        "/s/-bad/",
        &too_long,
        "/s/safe/../../etc/passwd",
        "/s/safe/nope",
    ] {
        assert_eq!(
            get(&fixture.config(), uri).await.status(),
            StatusCode::NOT_FOUND,
            "{uri}"
        );
    }
    let outside = fixture.0.with_extension("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("secret.txt"), "secret").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, page.join("escape")).unwrap();
    #[cfg(unix)]
    assert_eq!(
        get(&fixture.config(), "/s/safe/escape/secret.txt")
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    let _ = fs::remove_dir_all(outside);
}
