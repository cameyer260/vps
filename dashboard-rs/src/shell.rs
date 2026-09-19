//! App shell: the server-rendered page chrome.
//!
//! Port of `dashboard/index.html` + `BottomNav.tsx` + `TabHeader.tsx`:
//! one Askama template renders the full page for every tab (`/`, `/ide`,
//! `/gc`). Navigation is plain anchors upgraded by `hx-boost` (see the
//! template) — no client router, no JS tab state. Later phases fill the
//! `<main>` placeholders (agents UI in Phase 4, notes IDE in Phase 5).

use askama::Template;
use axum::response::Html;
use axum::routing::get;
use axum::Router;
use tower_http::services::ServeDir;

use crate::config::Config;

/// Dashboard tabs. The BottomNav pill shows all three, always, in this order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tab {
    Agents,
    Ide,
    Gc,
}

impl Tab {
    /// Server path for the tab (the BottomNav link target).
    pub fn path(&self) -> &'static str {
        match self {
            Tab::Agents => "/",
            Tab::Ide => "/ide",
            Tab::Gc => "/gc",
        }
    }

    /// Short pill label (BottomNav `TABS`).
    pub fn label(&self) -> &'static str {
        match self {
            Tab::Agents => "Agents",
            Tab::Ide => "IDE",
            Tab::Gc => "GC",
        }
    }

    /// Full name (TabHeader `TAB_TITLES`).
    pub fn title(&self) -> &'static str {
        match self {
            Tab::Agents => "Agents",
            Tab::Ide => "IDE",
            Tab::Gc => "General Chat",
        }
    }

    pub fn is_agents(&self) -> bool {
        *self == Tab::Agents
    }

    pub fn is_ide(&self) -> bool {
        *self == Tab::Ide
    }

    pub fn is_gc(&self) -> bool {
        *self == Tab::Gc
    }
}

/// Full-page shell. `tab` drives the header title, the BottomNav active
/// segment, and which `<main>` placeholder renders.
#[derive(Template)]
#[template(path = "shell.html")]
pub struct Shell {
    pub tab: Tab,
}

impl Shell {
    pub fn for_tab(tab: Tab) -> Self {
        Self { tab }
    }
}

async fn agents() -> Html<String> {
    Html(Shell::for_tab(Tab::Agents).render_or_empty())
}

async fn ide() -> Html<String> {
    Html(Shell::for_tab(Tab::Ide).render_or_empty())
}

async fn gc() -> Html<String> {
    Html(Shell::for_tab(Tab::Gc).render_or_empty())
}

/// Unknown extensionless paths render the app shell (the old SPA fallback
/// served `index.html`); asset misses stay 404s inside the ServeDir.
async fn fallback() -> Html<String> {
    Html(Shell::for_tab(Tab::Agents).render_or_empty())
}

trait RenderOrEmpty {
    fn render_or_empty(&self) -> String;
}

impl RenderOrEmpty for Shell {
    fn render_or_empty(&self) -> String {
        match self.render() {
            Ok(html) => html,
            Err(err) => {
                // Templates are compile-checked; a render failure here is a
                // bug, not user input — log and serve an empty 200 rather
                // than a bare 500 with no chrome.
                log::error!("shell render failed: {err}");
                String::new()
            }
        }
    }
}

/// Assemble the Phase 1 router: three tab pages, static assets, fallback.
pub fn router(config: &Config) -> Router {
    Router::new()
        .route("/", get(agents))
        .route("/ide", get(ide))
        .route("/gc", get(gc))
        .nest_service("/assets", ServeDir::new(&config.www_dir))
        .fallback(fallback)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn html(tab: Tab) -> String {
        Shell::for_tab(tab).render().expect("shell must render")
    }

    #[test]
    fn tab_metadata_matches_old_bottom_nav() {
        assert_eq!(
            [Tab::Agents.path(), Tab::Ide.path(), Tab::Gc.path()],
            ["/", "/ide", "/gc"]
        );
        assert_eq!(
            [Tab::Agents.label(), Tab::Ide.label(), Tab::Gc.label()],
            ["Agents", "IDE", "GC"]
        );
        assert_eq!(Tab::Gc.title(), "General Chat");
    }

    #[test]
    fn shell_carries_hx_boost_and_vendored_assets() {
        let page = html(Tab::Agents);
        assert!(page.contains("hx-boost=\"true\""), "hx-boost missing");
        for asset in [
            "/assets/js/htmx.min.js",
            "/assets/js/sse.js",
            "/assets/js/_hyperscript.min.js",
            "/assets/js/app.js",
            "/assets/css/app.css",
        ] {
            assert!(page.contains(asset), "{asset} missing");
        }
    }

    #[test]
    fn each_tab_marks_exactly_one_pill_active() {
        for tab in [Tab::Agents, Tab::Ide, Tab::Gc] {
            let page = html(tab);
            assert_eq!(
                page.matches("aria-selected=\"true\"").count(),
                1,
                "one active pill for {tab:?}"
            );
            assert_eq!(page.matches("aria-selected=\"false\"").count(), 2);
            assert!(page.contains(tab.title()), "header title missing");
        }
    }
}
