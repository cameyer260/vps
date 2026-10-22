# AGENTS.md

## Project summary

This repo is the admin site for `admin.christophermeyer.dev` — a read-only,
Obsidian-quality browser for the notes repo plus a surface for publishing
throwaway pages — together with the tooling I host and run on my VPS.
Single-user, Access-gated, native Rust binary under a systemd user unit.

## Commands

All of these run from `dashboard/`:

```bash
cargo run                 # serve on :3000 (PORT overrides; binds 0.0.0.0)
cargo test                # unit + router tests, no socket needed
cargo fmt --check && cargo clippy -- -D warnings

# only when styles change; app.css is committed, never built at deploy time
tailwindcss -i assets/css/input.css -o assets/css/app.css
```

The environment knobs and their defaults are in README "Running it".

The deployed `admin.service` owns port 3000, so a local dev server for manual
checks uses another port (`PORT=3001 cargo run`) and is stopped when the check
is over. Tests are unit tests beside their modules plus integration tests in
`dashboard/tests/` (`shell.rs` for the router and app shell, `publish.rs` for
the published-pages rules); `cargo test` needs no socket.

## Docs map

- `README.md` — human front door: what the repo is, the host setup (tunnel
  routes, ports, services, skill symlinks, screenshots timer registration).
- `docs/PRD.md` — behavior and requirements.
- `docs/ARCHITECTURE.md` — structure, invariants, and decisions with their reasons.

## Conventions

- Rust, edition 2024, one crate at `dashboard/` (binary `dashboard`).
- Server-rendered HTML with htmx; no client framework, no CDN —
  frontend assets are vendored into the repo.
- Tailwind CSS is built with the standalone CLI and the output is committed,
  so a deploy needs no CSS build step.
- No database. The filesystem is the source of truth.
- Gates: `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test` all
  green before a change is done.
- One heavy build at a time — the host has 2 vCPU and no swap. Work spread over
  several worktrees points them all at one shared target directory
  (`CARGO_TARGET_DIR=/home/dev/.cache/vps-target`): cargo locks it while it
  builds, so compiles queue instead of competing and the registry dependencies
  compile once.

## Repo invariants

- **The notes repo is read-only.** The app has no write path to `/home/dev/notes`;
  notes are viewed, never modified, in this version.
- **Published pages live outside the repo**, in a directory on the host. They are
  throwaway artifacts and never enter git.
- **Every served path must be validated to stay under its root** (notes root,
  published root), and symlinks must not escape it.
- **Nothing is public.** Both tunnel hostnames sit behind Cloudflare Access;
  never assume a route is unreachable, and never add a route without Access.
- **No secrets in the repo.** Credentials stay on the host.
- **Don't break host registrations**: `~/.config/systemd/user/admin.service` and
  `~/.config/systemd/user/prune-screenshots.*` symlink into `~/vps/tools/`, and
  skills symlink into `~/.agents/skills` and `~/.claude/skills`.
- **Cloudflare is always the owner's; a few host steps are delegated.** Never
  change anything in the Cloudflare dashboard on your own initiative. These host
  steps may be done without asking, because they are only this repo landing on
  the host: deploying the site (the README's upgrade steps — sync `~/vps`, build
  the release binary, restart `admin.service`), registering the skills symlinks
  (`~/.agents/skills/<name>` and `~/.claude/skills/<name>` →
  `~/vps/skills/<name>`), and updating the machine file `~/AGENTS.md` when this
  repo makes it stale (back the original up first and report the exact diff).
  Anything else on the host — installing software, starting or changing an
  unrelated service, new symlinks — is prepared and handed over.

## Documentation rules

**Definition of done.** A task is not done until ALL of these are true:

1. It is fully implemented in the repo and works (tests/verification pass).
2. The docs describe what was actually built, accurately.
3. The docs no longer describe it as planned: every `[Planned]` marker for it is removed entirely (built things carry no marker; the docs read as normal docs), and any planned-change wording is rewritten as plain present tense.

Docs are the primary way humans understand this project, because humans do not read the code. Update docs in the same change as the code.

- `PRD.md` describes behavior. `ARCHITECTURE.md` describes structure. If someone would otherwise need to open the code to learn it, document it.
- Prefer updating an existing doc over creating a new one. Don't duplicate content across docs; link instead.
- Create new docs when the project needs them (e.g. data model, API reference, deployment, testing, a feature deep-dive) and add them to the Docs map above.
- If you discover a doc is wrong or stale, fix it.
- Record decisions and their reasons in the "Decisions and why" section of ARCHITECTURE.md. Do not create separate ADR files.
