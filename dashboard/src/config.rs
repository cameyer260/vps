//! Deployment-time configuration.
//!
//! Every knob resolves from the environment, with defaults that match this
//! host (documented for humans in the README's "Running it"):
//!
//! | Env | Default | What it is |
//! |---|---|---|
//! | `NOTES_DIR` | `/home/dev/notes` | root of the notes repo (read-only) |
//! | `PUBLISHED_DIR` | `/home/dev/throwaway-pages` | root of the published pages |
//! | `PORT` | `3000` | listening port |
//! | `LOG_LEVEL` | `info` | default log filter (`RUST_LOG` still wins) |
//! | `ASSETS_DIR` | `<cwd>/assets` | vendored assets served at `/static` |

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

/// Resolved configuration, built once at boot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    /// The notes repo. Read-only: nothing in the app writes here.
    pub notes_root: PathBuf,
    /// The published-pages tree, one directory per slug.
    pub published_root: PathBuf,
    /// Port the site listens on.
    pub port: u16,
    /// Default log filter, used when `RUST_LOG` is unset.
    pub log_level: String,
    /// Vendored assets (`css/`, `js/`), served from `/static`.
    pub assets_dir: PathBuf,
    /// Fingerprint of those assets. It is appended to their URLs, so a deploy
    /// gets a new URL and neither the browser nor Cloudflare's edge can keep
    /// serving the previous stylesheet or script.
    pub asset_version: String,
}

impl Config {
    /// Read the process environment. This is the boot path.
    pub fn from_env() -> Self {
        Self::from_lookup(|key| env::var(key).ok())
    }

    /// Build from a key → value lookup. Tests use this instead of mutating
    /// the process environment (which racing tests make unsafe).
    ///
    /// Blank values count as unset; relative directory values resolve against
    /// the working directory.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let assets_dir = resolve_dir(lookup("ASSETS_DIR"), "assets", &cwd);
        let asset_version = asset_version(&assets_dir);
        Self {
            notes_root: resolve_dir(lookup("NOTES_DIR"), "/home/dev/notes", &cwd),
            published_root: resolve_dir(lookup("PUBLISHED_DIR"), "/home/dev/throwaway-pages", &cwd),
            port: parse_port(lookup("PORT").as_deref()),
            log_level: non_blank(lookup("LOG_LEVEL")).unwrap_or_else(|| "info".to_string()),
            assets_dir,
            asset_version,
        }
    }

    /// Sidebar label for the notes repo: the basename of its root, so a
    /// different `NOTES_DIR` names itself.
    pub fn vault_name(&self) -> String {
        vault_name(&self.notes_root)
    }

    /// Problems worth a warning at boot. A missing notes root is not fatal:
    /// the site still serves, with an empty tree, until the root exists. A
    /// missing published root is a normal empty state, not a warning.
    pub fn boot_warnings(&self) -> Vec<String> {
        let mut warnings = Vec::new();
        if !self.notes_root.is_dir() {
            warnings.push(format!(
                "notes root {} is missing or not a directory; the site will serve with an empty tree",
                self.notes_root.display()
            ));
        }
        warnings
    }
}

/// A fingerprint of the files under the assets directory: their paths relative
/// to it, and their bytes. It changes whenever a stylesheet or script does, and
/// it is stable for unchanged assets, so it is safe to cache them for a year
/// behind a versioned URL.
fn asset_version(assets_dir: &Path) -> String {
    use std::hash::{Hash, Hasher};

    let mut files = Vec::new();
    collect_files(assets_dir, &mut files);
    files.sort();

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for path in files {
        path.strip_prefix(assets_dir)
            .unwrap_or(&path)
            .to_string_lossy()
            .hash(&mut hasher);
        if let Ok(bytes) = fs::read(&path) {
            bytes.hash(&mut hasher);
        }
    }
    format!("{:016x}", hasher.finish())
}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, out);
        } else {
            out.push(path);
        }
    }
}

/// A configured directory. Blank or unset falls back to the default; a
/// relative value resolves against the working directory.
fn resolve_dir(raw: Option<String>, default: &str, cwd: &Path) -> PathBuf {
    let raw = non_blank(raw).unwrap_or_else(|| default.to_string());
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    }
}

/// `Some(trimmed)` when the value has content, `None` for unset or blank.
fn non_blank(raw: Option<String>) -> Option<String> {
    raw.map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// `PORT`, default 3000. Anything unparseable (or out of range for a port)
/// falls back to the default rather than failing later at bind time.
fn parse_port(raw: Option<&str>) -> u16 {
    raw.and_then(|value| value.trim().parse::<u16>().ok())
        .unwrap_or(3000)
}

/// Basename of the notes root, falling back to `notes` for a path with no
/// final component.
fn vault_name(notes_root: &Path) -> String {
    notes_root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "notes".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn cwd() -> PathBuf {
        env::current_dir().expect("tests run with a working directory")
    }

    fn from_vars(vars: &[(&str, &str)]) -> Config {
        let vars: HashMap<String, String> = vars
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();
        Config::from_lookup(|key| vars.get(key).cloned())
    }

    #[test]
    fn defaults_match_this_host() {
        let config = Config::from_lookup(|_| None);
        assert_eq!(config.notes_root, PathBuf::from("/home/dev/notes"));
        assert_eq!(
            config.published_root,
            PathBuf::from("/home/dev/throwaway-pages")
        );
        assert_eq!(config.port, 3000);
        assert_eq!(config.log_level, "info");
        assert_eq!(config.assets_dir, cwd().join("assets"));
        assert_eq!(config.asset_version.len(), 16, "the vendored assets hash");
    }

    #[test]
    fn environment_overrides_defaults() {
        let config = from_vars(&[
            ("NOTES_DIR", "/srv/vault"),
            ("PUBLISHED_DIR", "/srv/published"),
            ("PORT", "8080"),
            ("LOG_LEVEL", "debug"),
            ("ASSETS_DIR", "/srv/assets"),
        ]);
        assert_eq!(config.notes_root, PathBuf::from("/srv/vault"));
        assert_eq!(config.published_root, PathBuf::from("/srv/published"));
        assert_eq!(config.port, 8080);
        assert_eq!(config.log_level, "debug");
        assert_eq!(config.assets_dir, PathBuf::from("/srv/assets"));
    }

    #[test]
    fn blank_and_unparseable_values_fall_back_to_defaults() {
        let config = from_vars(&[
            ("NOTES_DIR", "   "),
            ("PUBLISHED_DIR", ""),
            ("PORT", "not-a-port"),
            ("LOG_LEVEL", ""),
            ("ASSETS_DIR", " "),
        ]);
        assert_eq!(config.notes_root, PathBuf::from("/home/dev/notes"));
        assert_eq!(
            config.published_root,
            PathBuf::from("/home/dev/throwaway-pages")
        );
        assert_eq!(config.port, 3000);
        assert_eq!(config.log_level, "info");
        assert_eq!(config.assets_dir, cwd().join("assets"));
    }

    #[test]
    fn the_asset_version_tracks_the_assets() {
        let dir = env::temp_dir().join(format!(
            "dashboard-asset-version-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("css")).unwrap();
        fs::write(dir.join("css/app.css"), b"a{}").unwrap();
        let root = dir.to_string_lossy().to_string();
        let version = |root: &str| {
            Config::from_lookup(|key| (key == "ASSETS_DIR").then(|| root.to_string())).asset_version
        };

        let first = version(&root);
        assert_eq!(first.len(), 16, "a short hex fingerprint");
        assert_eq!(first, version(&root), "stable while the assets are");
        fs::write(dir.join("css/app.css"), b"b{}").unwrap();
        assert_ne!(first, version(&root), "a change must bust the cache");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn relative_roots_resolve_against_the_working_directory() {
        let config = from_vars(&[("NOTES_DIR", "vault"), ("ASSETS_DIR", "./static")]);
        assert_eq!(config.notes_root, cwd().join("vault"));
        assert_eq!(config.assets_dir, cwd().join("static"));
    }

    #[test]
    fn port_parsing() {
        assert_eq!(parse_port(None), 3000);
        assert_eq!(parse_port(Some("")), 3000);
        assert_eq!(parse_port(Some("   ")), 3000);
        assert_eq!(parse_port(Some("8080")), 8080);
        assert_eq!(parse_port(Some(" 3001 ")), 3001);
        assert_eq!(parse_port(Some("abc")), 3000);
        assert_eq!(parse_port(Some("99999")), 3000); // out of u16 range
        assert_eq!(parse_port(Some("-1")), 3000);
    }

    #[test]
    fn vault_name_is_the_basename() {
        assert_eq!(vault_name(Path::new("/home/dev/notes")), "notes");
        assert_eq!(vault_name(Path::new("/srv/my-vault")), "my-vault");
        assert_eq!(vault_name(Path::new("/")), "notes");
    }

    #[test]
    fn a_missing_notes_root_warns_but_is_not_fatal() {
        let config = from_vars(&[("NOTES_DIR", "/nonexistent/notes-root-for-tests")]);
        let warnings = config.boot_warnings();
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("/nonexistent/notes-root-for-tests"));
        // The real notes root exists on this host, so booting is quiet.
        assert!(Config::from_lookup(|_| None).boot_warnings().is_empty());
    }
}
