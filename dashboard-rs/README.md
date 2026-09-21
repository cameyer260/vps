# dashboard-rs

Rust port of the VPS admin dashboard: Axum server, Askama templates,
htmx/hyperscript frontend, SSE streams. Working plan:
[`docs/rust-port.md`](../docs/rust-port.md); decisions: ADRs 0001–0005;
shared language: [`CONTEXT.md`](../CONTEXT.md).

Status: Phase 3 (bridge). The old TypeScript dashboard in `dashboard/`
is still the running implementation — this crate replaces it at cutover
(Phase 8 checklist in the port plan).

## Prerequisites (one-time, as dev)

```bash
# Rust toolchain (rustup installs to ~/.cargo; ~/.profile already sources it)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
rustup component add rustfmt clippy

# Tailwind standalone CLI v4 (single binary, lives on PATH — never in the repo)
curl -sL https://github.com/tailwindlabs/tailwindcss/releases/download/v4.3.3/tailwindcss-linux-x64 \
  -o ~/.local/bin/tailwindcss && chmod +x ~/.local/bin/tailwindcss
```

## Run

```bash
cargo run                    # :3000 (PORT overrides), prod runtime
MOCK_SCENARIO=empty cargo run   # mock runtime (dev only, see below)
```

Config is twelve env knobs with Q12 parity against
`dashboard/server/config.ts` (see `src/config.rs` header table).
Defaults match the VPS layout; nothing else is needed for the scaffold.

## Mock harness (Phase 2+)

`MOCK_SCENARIO=name cargo run` swaps the runtime seam for scripted fakes
(no Docker, no jarvis, no host mounts) — the Rust replacement for the old
dashboard's `MOCK_VPS=1` loop. Unknown names fail fast with the valid list.
Chat smoke test against the mock (Phase 3 bridge endpoints):

```bash
MOCK_SCENARIO=chat-streaming PORT=3847 cargo run &
curl -X POST -d "message=hello" localhost:3847/api/agents/mock-1/prompt
curl -N localhost:3847/api/agents/mock-1/stream   # init + entry events
curl -X POST localhost:3847/api/agents/mock-1/terminate
```

| Scenario         | Seeds                                                              |
|------------------|--------------------------------------------------------------------|
| `sidebar-full`   | 3 agents across 2 projects, mixed origins, one read-only           |
| `chat-streaming` | 1 agent with preloaded history; replies stream character by character |
| `notes-editor`   | 1 agent on the notes project                                       |
| `gc-chat`        | 1 read-only GC notes agent with history                            |
| `empty`          | no agents                                                          |

`MOCK_GRANULARITY=char|word|instant` overrides spawn reply streaming
(seeds keep their scenario granularity). Without either variable the
server boots the prod runtime (Docker + host supervisor; degrades, never
fails, when the daemon/socket is absent).

## Frontend pipeline

- `assets/js/`: vendored htmx + SSE extension + hyperscript (versions +
  sources in `VENDORED.md`), plus our `app.js` (viewport glue). No CDN.
- `assets/css/input.css` → `assets/css/app.css` via the Tailwind
  standalone CLI v4. The output is committed so deploys need no build step:

```bash
tailwindcss -i assets/css/input.css -o assets/css/app.css
```

## Validate (pre-merge gate per ADR 0005)

```bash
cargo fmt --check && cargo clippy -- -D warnings && cargo test
```

On this branch Rust work is validated by `cargo test`, not the old
dashboard's npm mock loop (that governs `dashboard/` only).
