//! Deployment-time configuration.
//!
//! Port of `dashboard/server/config.ts`: every knob resolves from the
//! environment with VPS-matching defaults. Twelve variables (Q12 parity
//! with the old server) — same names, same defaults, same validation:
//!
//! | # | Env | Default |
//! |---|-----|---------|
//! | 1 | `PORT` | `3000` |
//! | 2 | `AGENT_PROJECTS_DIR` | `/home/dev/projects` |
//! | 3 | `NOTES_DIR` | `/home/dev/notes` |
//! | 4 | `PI_SESSIONS_DIR` | `/home/dev/.pi/agent/sessions` |
//! | 5 | `JARVIS_BIN` | `/home/dev/vps/agent-images/jarvis.sh` |
//! | 6 | `AGENT_SKILLS_DIR` | `/home/dev/.agents` |
//! | 7 | `PI_SETTINGS_FILE` | `/home/dev/.pi/agent/settings.json` |
//! | 8 | `SCREENSHOTS_DIR` | `/home/dev/screenshots` |
//! | 9 | `HOME_DIR` (falls back to `HOME`) | `/home/dev` |
//! | 10 | `PI_HOST_SUPERVISOR_SOCK` | `/run/user/1000/pi-host-supervisor.sock` |
//! | 11 | `WWW_DIR` | `<cwd>/assets` (was `<cwd>/dist` for the Vite SPA) |
//! | 12 | `GC_IDLE_TIMEOUT_MS` | `3600000` (1h; zero/negative disables) |

use std::env;
use std::path::{Path, PathBuf};

/// Resolved configuration. Loaded once at startup via [`Config::from_env`].
#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub projects_dir: PathBuf,
    pub notes_dir: PathBuf,
    pub sessions_dir: PathBuf,
    pub jarvis_bin: PathBuf,
    pub skills_dir: PathBuf,
    pub pi_settings_file: PathBuf,
    pub screenshots_dir: PathBuf,
    /// Home dir host agents are confined to (whitelist root).
    pub home_dir: PathBuf,
    /// Host pi supervisor socket (see `docs/host-pi.md`).
    pub host_supervisor_sock: PathBuf,
    /// Static asset dir served at `/assets`.
    pub www_dir: PathBuf,
    /// Idle General Chat reap timeout. Zero disables the reaper.
    pub gc_idle_timeout_ms: u64,
}

impl Config {
    /// Read every knob from the environment, applying defaults.
    pub fn from_env() -> Self {
        Self {
            port: parse_port(env::var("PORT").ok().as_deref()),
            projects_dir: PathBuf::from(env_or("AGENT_PROJECTS_DIR", "/home/dev/projects")),
            notes_dir: PathBuf::from(env_or("NOTES_DIR", "/home/dev/notes")),
            sessions_dir: PathBuf::from(env_or("PI_SESSIONS_DIR", "/home/dev/.pi/agent/sessions")),
            jarvis_bin: PathBuf::from(env_or("JARVIS_BIN", "/home/dev/vps/agent-images/jarvis.sh")),
            skills_dir: PathBuf::from(env_or("AGENT_SKILLS_DIR", "/home/dev/.agents")),
            pi_settings_file: PathBuf::from(env_or(
                "PI_SETTINGS_FILE",
                "/home/dev/.pi/agent/settings.json",
            )),
            screenshots_dir: PathBuf::from(env_or("SCREENSHOTS_DIR", "/home/dev/screenshots")),
            home_dir: PathBuf::from(
                env::var("HOME_DIR")
                    .or_else(|_| env::var("HOME"))
                    .unwrap_or_else(|_| "/home/dev".to_string()),
            ),
            host_supervisor_sock: PathBuf::from(env_or(
                "PI_HOST_SUPERVISOR_SOCK",
                "/run/user/1000/pi-host-supervisor.sock",
            )),
            www_dir: resolve_www_dir(env::var("WWW_DIR").ok()),
            gc_idle_timeout_ms: parse_gc_timeout(env::var("GC_IDLE_TIMEOUT_MS").ok().as_deref()),
        }
    }

    /// Human-facing grouping name for the notes workspace: its basename.
    pub fn notes_name(&self) -> String {
        notes_name(&self.notes_dir)
    }

    /// Validate a bare project name and resolve it to its host directory.
    /// The notes name maps to the notes dir; anything else must match
    /// `^[A-Za-z0-9][A-Za-z0-9._-]*$`.
    pub fn project_dir(&self, name: &str) -> Option<PathBuf> {
        project_dir(&self.notes_dir, &self.projects_dir, name)
    }
}

fn env_or(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.to_string())
}

/// `PORT`, default 3000. Unparseable values fall back to the default
/// (the old server would hand NaN to the listener and fail at boot).
pub fn parse_port(raw: Option<&str>) -> u16 {
    const DEFAULT: u16 = 3000;
    match raw {
        None => DEFAULT,
        Some(s) => s.trim().parse::<u16>().unwrap_or(DEFAULT),
    }
}

/// `GC_IDLE_TIMEOUT_MS`, default 1h. Unset/blank/unparseable means the
/// default; zero or negative disables the reaper (dashboards that prefer
/// manual cleanup).
pub fn parse_gc_timeout(raw: Option<&str>) -> u64 {
    const DEFAULT: u64 = 3_600_000;
    let s = match raw {
        None => return DEFAULT,
        Some(s) if s.trim().is_empty() => return DEFAULT,
        Some(s) => s.trim(),
    };
    match s.parse::<i64>() {
        Ok(n) if n > 0 => n as u64,
        Ok(_) => 0,
        Err(_) => DEFAULT,
    }
}

/// Resolve the static asset dir: explicit `WWW_DIR` wins (relative values
/// join onto the cwd); the default is `<cwd>/assets`.
fn resolve_www_dir(raw: Option<String>) -> PathBuf {
    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    match raw {
        Some(s) if !s.trim().is_empty() => {
            let p = PathBuf::from(s.trim());
            if p.is_absolute() {
                p
            } else {
                cwd.join(p)
            }
        }
        _ => cwd.join("assets"),
    }
}

/// Basename of the notes dir (falls back to `"notes"` when the path has
/// no final component).
pub fn notes_name(notes_dir: &Path) -> String {
    notes_dir
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "notes".to_string())
}

/// First character must be ASCII alphanumeric; the rest alphanumeric or
/// `.`, `_`, `-`. Hand-rolled on purpose — no regex crate for one check.
fn valid_project_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphanumeric() => (),
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

pub fn project_dir(notes_dir: &Path, projects_dir: &Path, name: &str) -> Option<PathBuf> {
    if name == notes_name(notes_dir) {
        return Some(notes_dir.to_path_buf());
    }
    if !valid_project_name(name) {
        return None;
    }
    Some(projects_dir.join(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_defaults_and_overrides() {
        assert_eq!(parse_port(None), 3000);
        assert_eq!(parse_port(Some("")), 3000);
        assert_eq!(parse_port(Some("8080")), 8080);
        assert_eq!(parse_port(Some(" 3001 ")), 3001);
        assert_eq!(parse_port(Some("abc")), 3000);
        assert_eq!(parse_port(Some("99999")), 3000); // out of u16 range
    }

    #[test]
    fn gc_timeout_parsing() {
        assert_eq!(parse_gc_timeout(None), 3_600_000);
        assert_eq!(parse_gc_timeout(Some("")), 3_600_000);
        assert_eq!(parse_gc_timeout(Some("   ")), 3_600_000);
        assert_eq!(parse_gc_timeout(Some("60000")), 60_000);
        assert_eq!(parse_gc_timeout(Some("0")), 0); // disabled
        assert_eq!(parse_gc_timeout(Some("-5")), 0); // disabled
        assert_eq!(parse_gc_timeout(Some("abc")), 3_600_000);
    }

    #[test]
    fn notes_name_is_basename() {
        assert_eq!(notes_name(Path::new("/home/dev/notes")), "notes");
        assert_eq!(notes_name(Path::new("/data/my-notes")), "my-notes");
        assert_eq!(notes_name(Path::new("/")), "notes");
    }

    #[test]
    fn project_dir_validation() {
        let notes = Path::new("/home/dev/notes");
        let projects = Path::new("/home/dev/projects");
        // Notes name resolves to the notes dir even though "notes" is also
        // a syntactically valid project name.
        assert_eq!(
            project_dir(notes, projects, "notes"),
            Some(PathBuf::from("/home/dev/notes"))
        );
        assert_eq!(
            project_dir(notes, projects, "alpha"),
            Some(PathBuf::from("/home/dev/projects/alpha"))
        );
        assert_eq!(
            project_dir(notes, projects, "my.proj_2-x"),
            Some(PathBuf::from("/home/dev/projects/my.proj_2-x"))
        );
        for bad in ["", ".", "..", "../x", "a/b", " a", "-x", ".x", "x y", "x/y"] {
            assert_eq!(project_dir(notes, projects, bad), None, "{bad:?}");
        }
    }
}
