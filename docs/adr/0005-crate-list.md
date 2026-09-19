# Dashboard crate list — minimal by design, with explicit no's

Confirmed dependencies for the Rust dashboard: tokio, axum, bollard,
serde/serde_json, askama, pulldown-cmark, ammonia (the original core list),
plus thiserror/anyhow (error plumbing), tower-http (static asset serving),
log + env_logger (it's a systemd service), and `time` (RFC3339 pi entry
timestamps; relative "2h ago" is hand-rolled).

Deliberately absent, and it stays that way unless a proven need appears:
no WebSocket crate (SSE is native axum; ADR 0003), no uuid (ids come from
Docker or host-<ts>-<seq>), no CSV crate (hand-rolled), no syntax highlighter
(deferred — add syntect if missed), no database (nothing persists today that
needs one), no file watcher, no image processing, no auth/session crate
(Cloudflare Access is the auth boundary; zero cookies means no CSRF surface).
Adding a crate requires a demonstrated need, not convenience.

Non-Cargo tooling: Tailwind standalone CLI (dev watcher + build; compiled
CSS is committed so deploys need no build step), and htmx + its SSE
extension + hyperscript are vendored into assets/ and served by the app
itself — no CDN, no node. Pre-merge gate: cargo fmt --check, clippy -D
warnings, cargo test (the ADR-0001 moral of the old typecheck+build+smoke).
