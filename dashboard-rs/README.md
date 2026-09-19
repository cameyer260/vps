# dashboard-rs

Rust port of the VPS admin dashboard: Axum server, Askama templates,
htmx/hyperscript frontend, SSE streams. Working plan:
[`docs/rust-port.md`](../docs/rust-port.md); decisions: ADRs 0001–0005;
shared language: [`CONTEXT.md`](../CONTEXT.md).

Status: Phase 1 (scaffold). The old TypeScript dashboard in `dashboard/`
is still the running implementation — this crate replaces it at cutover
(Phase 8 checklist in the port plan).

## Run

```bash
cargo run                    # :3000 (PORT overrides)
```

Config is twelve env knobs with Q12 parity against
`dashboard/server/config.ts` (see `src/config.rs` header table).
Defaults match the VPS layout; nothing else is needed for the scaffold.

## Frontend pipeline

- `assets/js/`: vendored htmx + SSE extension + hyperscript (versions +
  sources in `VENDORED.md`), plus our `app.js` (viewport glue). No CDN.
- `assets/css/input.css` → `assets/css/app.css` via the Tailwind
  standalone CLI v4. The output is committed so deploys need no build step:

```bash
tailwindcss -i assets/css/input.css -o assets/css/app.css --minify
```

## Validate (pre-merge gate per ADR 0005)

```bash
cargo fmt --check && cargo clippy -- -D warnings && cargo test
```

On this branch Rust work is validated by `cargo test`, not the old
dashboard's npm mock loop (that governs `dashboard/` only).
