//! Markdown pipeline: pulldown-cmark + ammonia (ADR 0003).
//!
//! Port of the `Markdown` component in
//! `dashboard/src/components/MessageView.tsx` (ReactMarkdown + remark-gfm),
//! run server-side: the bridge renders every assistant text block to
//! sanitized HTML once, and SSE carries fragments — no client markdown
//! renderer, no client chat state machine.

use pulldown_cmark::{Options, Parser, html};

/// GFM option set matching remark-gfm: tables, footnotes, strikethrough,
/// task lists. Smart punctuation stays off (the old renderer never did it).
fn gfm_options() -> Options {
    Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
}

/// Render Markdown to sanitized HTML. Raw HTML in the source is stripped by
/// ammonia (the model can emit anything); the output is safe to swap into
/// the page with htmx.
pub fn render_markdown(src: &str) -> String {
    let parser = Parser::new_ext(src, gfm_options());
    let mut html_out = String::new();
    html::push_html(&mut html_out, parser);
    sanitize(&html_out)
}

/// Sanitize an already-rendered HTML fragment. Task-list checkboxes
/// (`<input type="checkbox" disabled>`) are kept so GFM checklists render;
///
/// everything else follows ammonia's defaults.
fn sanitize(html: &str) -> String {
    ammonia::Builder::default()
        .add_tags(["input"])
        .add_generic_attributes(["align"])
        .add_tag_attributes("input", &["type", "checked", "disabled"])
        .add_tag_attributes("code", &["class"])
        .add_tag_attributes("pre", &["class"])
        .clean(html)
        .to_string()
}

/// Escape a plain-text string for HTML interpolation (user messages, tool
/// args/results, thinking — everything that is not Markdown).
pub fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#x27;"),
            _ => out.push(c),
        }
    }
    out
}

/// Plain-text paragraph rendering for user bubbles: escaped, newlines kept
/// as `<br>` (the old UI rendered user text raw, never as Markdown).
pub fn render_plain(text: &str) -> String {
    escape_html(text).replace('\n', "<br>")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gfm_renders_and_scripts_are_stripped() {
        let html = render_markdown(
            "# hi\n\n<script>alert(1)</script>\n\n| a | b |\n|---|---|\n| 1 | 2 |\n",
        );
        assert!(html.contains("<h1>"), "{html}");
        assert!(html.contains("<table>"), "{html}");
        assert!(!html.contains("<script>"), "{html}");
        assert!(!html.contains("alert(1)"), "{html}");
    }

    #[test]
    fn markdown_links_keep_href_but_lose_javascript() {
        let html = render_markdown("[x](javascript:alert(1)) [y](https://example.com)");
        assert!(!html.contains("javascript:"), "{html}");
        assert!(html.contains("https://example.com"), "{html}");
    }

    #[test]
    fn strikethrough_and_task_lists_survive() {
        let html = render_markdown("~~gone~~\n\n- [x] done\n- [ ] todo\n");
        assert!(html.contains("<del>") || html.contains("<s>"), "{html}");
        assert!(html.contains("checkbox"), "{html}");
    }

    #[test]
    fn escape_and_plain_newlines() {
        assert_eq!(escape_html("<a>&\"'"), "&lt;a&gt;&amp;&quot;&#x27;");
        assert_eq!(render_plain("a<b\nc"), "a&lt;b<br>c");
        // Plain rendering never interprets Markdown.
        assert!(!render_plain("# hi").contains("<h1>"));
    }
}
