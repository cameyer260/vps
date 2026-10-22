//! Markdown-to-HTML pipeline for read-only notes.
use ammonia::Builder;
use pulldown_cmark::{Options, Parser, html};
use std::path::Path;

pub const MAX_INLINE_BYTES: u64 = 1_048_576;

pub fn render(source: &str, current_path: &str, notes_root: &Path) -> (String, String) {
    let (properties, body) = split_frontmatter(source);
    let body = obsidian_markdown(body, current_path, notes_root);
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_HEADING_ATTRIBUTES;
    let mut html_out = String::new();
    html::push_html(&mut html_out, Parser::new_ext(&body, options));
    html_out = render_callouts(&html_out);
    html_out = rewrite_relative_links(&html_out, current_path);
    // pulldown-cmark emits code language classes and task-list inputs.
    let safe = Builder::default()
        .add_tags(["input", "mark", "span"])
        .add_tag_attributes("a", &["id", "class", "href"])
        .add_tag_attributes("input", &["type", "checked", "disabled"])
        .add_tag_attributes("code", &["class"])
        .add_tag_attributes("span", &["class"])
        .add_tag_attributes("li", &["class"])
        .add_tag_attributes("blockquote", &["class"])
        .add_tag_attributes("div", &["class"])
        .add_tag_attributes("th", &["align"])
        .add_tag_attributes("td", &["align"])
        .clean(&html_out)
        .to_string();
    (properties, safe)
}

fn render_callouts(html: &str) -> String {
    let mut output = String::new();
    let mut rest = html;
    while let Some(start) = rest.find("<blockquote>\n<p>[!") {
        output.push_str(&rest[..start]);
        let block_start = start + "<blockquote>\n<p>[!".len();
        let Some(marker_end) = rest[block_start..].find(']') else {
            output.push_str(&rest[start..]);
            return output;
        };
        let marker_end = block_start + marker_end;
        let callout_type = &rest[block_start..marker_end];
        if callout_type.is_empty()
            || !callout_type
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
        {
            output.push_str(&rest[start..start + "<blockquote>".len()]);
            rest = &rest[start + "<blockquote>".len()..];
            continue;
        }
        let Some(line_end) = rest[marker_end + 1..]
            .find("<br />\n")
            .or_else(|| rest[marker_end + 1..].find("</p>"))
        else {
            output.push_str(&rest[start..]);
            return output;
        };
        let line_end = marker_end + 1 + line_end;
        let title = rest[marker_end + 1..line_end].trim();
        output.push_str(&format!(
            "<blockquote class=\"callout callout-{}\"><div class=\"callout-title\">{}</div>",
            callout_type.to_ascii_lowercase(),
            title
        ));
        if rest[line_end..].starts_with("<br />\n") {
            rest = &rest[line_end + "<br />\n".len()..];
            if let Some(close) = rest.find("</p>") {
                output.push_str("<p>");
                output.push_str(&rest[..close]);
                output.push_str("</p>");
                rest = &rest[close + 4..];
            }
        } else {
            rest = &rest[line_end + 4..];
        }
    }
    output.push_str(rest);
    output
}

fn obsidian_markdown(body: &str, current_path: &str, notes_root: &Path) -> String {
    let parent = Path::new(current_path).parent().unwrap_or(Path::new(""));
    let mut out = String::new();
    let mut rest = body;
    while let Some(start) = rest.find("[[") {
        out.push_str(&rest[..start]);
        let Some(end) = rest[start + 2..].find("]]") else {
            out.push_str(&rest[start..]);
            return finish_markup(out);
        };
        let raw = &rest[start + 2..start + 2 + end];
        let (target, label) = raw.split_once('|').unwrap_or((raw, raw));
        let clean = target.split('#').next().unwrap_or(target);
        let target_path = if clean.ends_with(".md") {
            clean.to_string()
        } else {
            format!("{clean}.md")
        };
        let dest = parent
            .join(&target_path)
            .components()
            .filter_map(|c| match c {
                std::path::Component::Normal(x) => Some(x.to_string_lossy().to_string()),
                std::path::Component::ParentDir => Some("..".into()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("/");
        let escaped_label = escape(label);
        let href = format!("/notes/{}", url_path(&dest));
        let resolved = std::fs::canonicalize(notes_root.join(&dest))
            .ok()
            .zip(std::fs::canonicalize(notes_root).ok())
            .is_some_and(|(file, root)| file.starts_with(root) && file.is_file());
        let class = if resolved {
            "internal-link"
        } else {
            "internal-link unresolved"
        };
        out.push_str(&format!(
            "<a class=\"{class}\" href=\"{href}\">{escaped_label}</a>"
        ));
        rest = &rest[start + 2 + end + 2..];
    }
    out.push_str(rest);
    finish_markup(out)
}
fn finish_markup(mut s: String) -> String {
    // Highlight syntax is constrained to one-line spans; escaped user text cannot inject HTML.
    while let Some(start) = s.find("==") {
        let Some(end) = s[start + 2..].find("==") else {
            break;
        };
        let middle = s[start + 2..start + 2 + end].to_string();
        s.replace_range(
            start..start + end + 4,
            &format!("<mark>{}</mark>", escape(&middle)),
        );
    }
    // Tags are rendered as inert styled spans, outside URLs and fenced code (simple inline form).
    let mut tagged = String::new();
    let mut chars = s.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '#'
            && (tagged.is_empty() || tagged.chars().last().is_some_and(char::is_whitespace))
            && chars.peek().is_some_and(|c| c.is_alphanumeric())
        {
            let mut tag = String::new();
            while chars
                .peek()
                .is_some_and(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
            {
                tag.push(chars.next().unwrap());
            }
            tagged.push_str(&format!("<span class=\"tag\">#{}</span>", escape(&tag)));
        } else {
            tagged.push(ch);
        }
    }
    tagged
}
fn split_frontmatter(source: &str) -> (String, &str) {
    let original = source;
    let source = source.strip_prefix("\u{feff}").unwrap_or(source);
    let source = source
        .strip_prefix("---\r\n")
        .or_else(|| source.strip_prefix("---\n"));
    if let Some(rest) = source {
        for delimiter in ["\n---\n", "\r\n---\r\n", "\n---\r\n"] {
            if let Some(end) = rest.find(delimiter) {
                let yaml = &rest[..end];
                let mut props = String::from("<dl class=\"properties\">");
                for line in yaml.lines() {
                    if let Some((k, v)) = line.split_once(':')
                        && matches!(k.trim(), "file" | "last_updated")
                    {
                        props.push_str(&format!(
                            "<dt>{}</dt><dd>{}</dd>",
                            escape(k.trim()),
                            escape(v.trim())
                        ))
                    }
                }
                props.push_str("</dl>");
                return (
                    props,
                    rest[end + delimiter.len()..].trim_start_matches(['\n', '\r']),
                );
            }
        }
    }
    (String::new(), original)
}
fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
fn rewrite_relative_links(html: &str, current_path: &str) -> String {
    let mut out = String::new();
    let mut rest = html;
    while let Some(pos) = rest.find("href=\"") {
        out.push_str(&rest[..pos + 6]);
        let value = &rest[pos + 6..];
        let Some(end) = value.find('\"') else {
            out.push_str(value);
            return out;
        };
        let href = &value[..end];
        let suffix_at = href.find(['#', '?']).unwrap_or(href.len());
        let (destination, suffix) = href.split_at(suffix_at);
        if destination.to_ascii_lowercase().ends_with(".md")
            && !destination.starts_with('/')
            && !destination.contains("://")
        {
            let resolved = Path::new(current_path)
                .parent()
                .unwrap_or(Path::new(""))
                .join(destination);
            let path = resolved
                .components()
                .filter_map(|c| match c {
                    std::path::Component::Normal(p) => Some(p.to_string_lossy().to_string()),
                    std::path::Component::ParentDir => Some("..".into()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("/");
            out.push_str(&format!("/notes/{}{}", url_path(&path), suffix));
        } else {
            out.push_str(href);
        }
        out.push('"');
        rest = &value[end + 1..];
    }
    out.push_str(rest);
    out
}

fn url_path(s: &str) -> String {
    s.split('/')
        .map(|p| {
            p.bytes()
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frontmatter_and_gfm_render() {
        let (p, h) = render(
            "---\nfile: main.md\nlast_updated: today\nother: x\n---\n# Hello\n\n- [ ] todo\n\n|a|b|\n|-|-|\n|1|2|\n\n~~gone~~[^1]\n\n[^1]: footnote",
            "main.md",
            Path::new("/nonexistent"),
        );
        assert!(p.contains("last_updated"));
        assert!(!p.contains("other"));
        assert!(!h.contains("---"));
        assert!(h.contains("<table>"));
        assert!(h.contains("type=\"checkbox\""));
        assert!(h.contains("<del>gone</del>"));
        assert!(h.contains("footnote"));
    }
    #[test]
    fn anchors_wikilinks_highlights_tags_and_callouts() {
        let (_, h) = render(
            "<a id=\"context-001\"></a>\n\n[[other|Other]] ==bright== #focus\n\n> [!warning] Careful\n> body",
            "folder/note.md",
            Path::new("/nonexistent"),
        );
        assert!(h.contains("id=\"context-001\""));
        assert!(h.contains("/notes/folder/other.md"));
        assert!(h.contains("unresolved"));
        assert!(h.contains("<mark>bright</mark>"));
        assert!(h.contains("class=\"tag\""));
        assert!(h.contains("callout-warning"));
        assert!(h.contains("Careful"));
        assert!(h.contains("body"));
        assert!(!h.contains("[!warning]"));
    }
    #[test]
    fn hostile_raw_html_is_removed() {
        let (_, html) = render(
            "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<a href=\"javascript:alert(1)\" onclick=\"alert(1)\">bad</a>\n\n<style>body{display:none}</style>",
            "hostile.md",
            Path::new("/nonexistent"),
        );
        let lower = html.to_ascii_lowercase();
        assert!(!lower.contains("<script"));
        assert!(!lower.contains("onerror"));
        assert!(!lower.contains("onclick"));
        assert!(!lower.contains("javascript:"));
        assert!(!lower.contains("<style"));
    }

    #[test]
    fn relative_markdown_links_remain_site_links() {
        let (_, h) = render(
            "[other](other.md#context-001)",
            "folder/note.md",
            Path::new("/nonexistent"),
        );
        assert!(h.contains("href=\"/notes/folder/other.md#context-001\""));
    }
}
