# Rust port plan

Working plan for the rust-port branch. Records phasing and the cutover
checklist; the decisions and their rationale live in the ADRs (0001–0005) —
this file links, it does not repeat them. Delete this file at cutover.

Scope: [ADR 0001](adr/0001-port-dashboard-to-rust.md) (in: dashboard server +
frontend, host supervisor last; out: pi extension, jarvis, git bridge, prune).
Deployment: [ADR 0002](adr/0002-native-systemd-deployment.md) (systemd user
service, no container). Frontend: [ADR 0003](adr/0003-server-rendered-htmx-frontend-sse.md)
(htmx + Askama, SSE only, server-rendered chat). Notes editing:
[ADR 0004](adr/0004-notes-editing-plain-textarea.md) (textarea swap, no
WYSIWYG). Crates: [ADR 0005](adr/0005-crate-list.md) (minimal list, explicit
no's). Shared language: [CONTEXT.md](../CONTEXT.md).

## Phases (each lands green: fmt, clippy -D warnings, cargo test)

1. **Scaffold** — `dashboard-rs/` crate, config (Q12 parity), assets/ with
   vendored htmx+SSE ext+hyperscript, committed Tailwind output, app shell
   page with hx-boost + bottom nav, ServeDir.
2. **Runtime seam** — `runtime/` module: trait `Runtime`, `docker.rs`,
   `host.rs`, `mock.rs` + `fake_pi.rs`; five scenarios by env var.
3. **Bridge** — entry state, pi RPC over attach, markdown pipeline
   (pulldown-cmark + ammonia), SSE chat stream (`init`/`entry`/`delta`/
   `status`/`notice`), POST commands, coalesced deltas, cached state,
   dropped-dialog notice, terminate→exited broadcast, logs ring buffer,
   GC reaper (1h continuous no-viewer rule), never-stop-on-disconnect.
4. **Agents UI** — overview cards, global SSE agent feed, start dialog
   (jarvis/host, read-only, resume), chat page, model picker + scope file
   read, terminate.
5. **Notes IDE** — tree, viewer, textarea edit swap (autosave, list
   continuation, Tab-indent, draft warning), search, CSV grid, sessions
   browser, git surface (spawned git, ceiling dirs), uploads, skills.
6. **PWA** — icons/manifest port, sw.js port (verbatim semantics).
7. **Supervisor** — port pi-host-supervisor.mjs to a second binary, same
   socket protocol (`docs/host-pi.md`), swap on the VPS.
8. **Cutover** — checklist below, on main.

Reference for each phase — the old TypeScript implementation in `dashboard/`
(map: `dashboard/ARCHITECTURE.md`). Read these before writing Rust; port
semantics, not shape (old code is vibe-coded — write the clean version;
ADR 0001):

| Phase | Read in old `dashboard/` |
|---|---|
| 1 scaffold | `index.html`, `src/app.css`, `public/` |
| 2 runtime | `server/runtime*.ts`, `server/docker.ts`, `server/mock/` |
| 3 bridge | `server/{bridge,events,index,gc-reaper}.ts`, `src/chat.ts` (stream semantics only) |
| 4 agents UI | `src/components/{StartDialog,ChatView,AgentsSections,TerminateButton}.tsx`, `server/routes.ts` |
| 5 notes IDE | `src/components/{IdeView,MarkdownEditor,CsvEditor,TreeModal}.tsx`, `server/{files,sessions,git,skills}.ts` |
| 6 PWA | `public/sw.js`, `public/manifest.webmanifest` |
| 7 supervisor | `tools/pi-host-supervisor.mjs`, `server/{host-supervisor,runtime-host}.ts`, `docs/host-pi.md` |
| 8 cutover | this checklist |

## Running the port with agents

One phase per agent session, in order — each depends on the last. Prompt:

```
Implement Phase N of docs/rust-port.md. Read AGENTS.md, CONTEXT.md,
docs/rust-port.md and every ADR it links first, following doc
cross-references. Work only in `dashboard-rs/` (and docs where this plan
says so); never touch `dashboard/`, agent-images/, or tools/ except reading.
```

Each session ends green (fmt, clippy -D warnings, cargo test) and committed
as one scoped commit. Note for agents: AGENTS.md's npm mock loop governs the
*old* dashboard only — on this branch, `dashboard-rs/` work is validated by
the Rust mock harness (Phase 2+) instead; there is no VPS access from agent
sessions, by design.

## Cutover checklist (one-time, on the VPS)

Steps 1–2 are one atomic change on main: the move and the directory deletion
land together. Running prod is not a dependency — it runs from its own
container and checkout, untouched until the new binary is deliberately
deployed (below).

- [ ] `git mv dashboard/pi-extension agent-images/pi-extension`; update
      `jarvis.sh` (`REPO_ROOT/agent-images/…`), `docs/jarvis.md`, AGENTS.md.
- [ ] Delete old `dashboard/`; rename `dashboard-rs/` → `dashboard/`.
- [ ] Write new `dashboard/README.md` + `ARCHITECTURE.md` (Rust internals;
      bridge contract + the two load-bearing safety properties).
- [ ] Author `dashboard.service` user unit (binary path, env from ADR-0002
      world, ExecStart); deploy notes in README.
- [ ] Root README doc map + AGENTS.md rewrite: mock loop →
      `MOCK_SCENARIO=… cargo run` + cargo test gate; testing.md rewritten.
- [ ] VPS: stop/remove old dashboard container + image; install release
      binary; start unit; verify SSE keepalive survives Cloudflare (~100s
      idle limit); delete this file.
