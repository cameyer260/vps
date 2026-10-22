# vps

The admin site at `admin.christophermeyer.dev`, plus the tooling I host and run
on my VPS.

## What lives here

| Path | What it is |
|---|---|
| `dashboard/` | The admin site: a read-only, Obsidian-quality browser for the notes repo (tree, reading view, filename search, attachments), plus a surface for publishing throwaway pages (visuals, prototypes, demos) at `admin.christophermeyer.dev/s/<slug>/`. |
| `skills/` | Agent skills that make the site usable from an agent session — publishing a page, and putting a dev server up for review from outside the VPS. Registered on this host. |
| `tools/` | Host tooling that runs on the VPS itself: `tools/admin.service`, the systemd user unit for the site, and `tools/prune-screenshots.*`, a systemd user timer that prunes the screenshots inbox daily. Both in daily use. |
| `docs/` | PRD (behavior) and ARCHITECTURE (structure and decisions). |

Status: **alpha.** `dashboard/` is a Rust crate that serves the app shell, the
read-only notes browser (tree, Obsidian-fidelity reading view, filename search,
read-only attachments) and published pages at `/s/<slug>/`; the Tailwind
stylesheet is built and committed. It runs on this host as the `admin.service`
systemd user unit, live on `admin.christophermeyer.dev` behind Cloudflare
Access. The two agent skills in `skills/` are registered on this host. The
project was re-founded from documentation; it replaced the older TypeScript
agent-management dashboard, which is no longer used (agents run from `herdr` on
this machine).

## Documentation map

| You want… | Go to |
|---|---|
| What the site does, feature by feature | [docs/PRD.md](docs/PRD.md) |
| How it is put together, and why | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Instructions for agents working here | [AGENTS.md](AGENTS.md) |

## Running it

Prerequisites: `rustup`/`cargo` and the Tailwind standalone CLI — both already
installed on this host. There is no Node runtime and no `npm` step.

```bash
cd dashboard
cargo run                 # http://localhost:3000 (PORT overrides; binds 0.0.0.0)
cargo test                # unit tests + router tests
cargo fmt --check && cargo clippy -- -D warnings

# Only when styles change — the built stylesheet is committed, so a deploy
# needs no CSS build:
tailwindcss -i assets/css/input.css -o assets/css/app.css
```

The deployed unit owns port 3000, so a local dev server for manual checks takes
another one (`PORT=3001 cargo run`) and is stopped when the check is over.
`dashboard/tests/` holds the integration tests next to the unit tests in
`src/` — `shell.rs` for the router and app shell, `publish.rs` for the
published-pages rules.

The vendored assets are requested with a content fingerprint (`?v=…`) and cached
immutably, so a deploy never leaves a stale stylesheet or script in a browser or
at the Cloudflare edge. `/` serves the app shell with the notes tree and the
reading pane, `/notes/…`
renders a note or serves an attachment (over the 1 MiB cap a download link is
shown instead), `/download/notes/…` downloads a file, `/s/<slug>/` serves a
published page, `/health` answers `ok`, and `/static/…` serves the vendored
assets (no CDN, no `npm`).

Configuration is environment-only, with defaults that match this host
(`dashboard/src/config.rs` is the reference):

| Env | Default | What it is |
|---|---|---|
| `NOTES_DIR` | `/home/dev/notes` | root of the notes repo, read-only |
| `PUBLISHED_DIR` | `/home/dev/throwaway-pages` | root of the published pages |
| `PORT` | `3000` | listening port |
| `LOG_LEVEL` | `info` | log filter (`RUST_LOG` still wins) |
| `ASSETS_DIR` | `<working dir>/assets` | static assets served at `/static` |

A missing notes root logs a warning and still boots; the tree is empty until the
root exists. The site is reached over Tailscale at `<tailscale-ip>:3000`.

## Host setup (the VPS)

Everything runs as the unprivileged `dev` user. There is no passwordless
sudo, and long-running processes belong to systemd *user* services (linger is
enabled for `dev`).

**Machine.** Hostinger VPS, Ubuntu 24.04.4 LTS, 2 vCPU, ~8 GB RAM (no swap),
96 GB disk, hostname `srv1195117`.

**Network.** Inbound public traffic is dropped. UFW permits SSH only over
`tailscale0`, so the machine is normally reached over Tailscale. The only
public route in is a Cloudflare tunnel to localhost, and Cloudflare Access
gates every hostname on it — only the owner's account gets through.

**Tunnel.** `cloudflared` runs as a systemd user unit
(`cloudflared.service`), driven by a remotely-managed token in
`~/.config/cloudflared/token.env`. The routes live in the Cloudflare
dashboard, not in a file on this machine, and there is no Cloudflare API
token on the host — adding a route or an Access hostname is a dashboard
change, never a repo change.

| Hostname | Routes to | What it is |
|---|---|---|
| `admin.christophermeyer.dev` | `http://localhost:3000` | the admin site |
| `dev.christophermeyer.dev` | `http://localhost:4173` | a dev server put up for review from outside the VPS — Access-gated, one at a time |

**Ports.** 3000 — the admin site. 4173 — the one dev-review server (one at a
time; if something already holds the port, the skill reports it to the owner and
waits for his call rather than killing it on its own).

**Published pages.** Throwaway pages live in `/home/dev/throwaway-pages/<slug>/`
(`PUBLISHED_DIR` overrides): an `index.html` in a slug directory is served at
`/s/<slug>/`, sibling assets from the same directory, as-is. Slugs are 1–64
characters of `[a-z0-9][a-z0-9-]*`; other entries in the root are ignored. `/s/`
lists what is published, newest first by directory mtime, and deleting a
directory unpublishes it. These pages are throwaway: they never enter git, and
they are only reachable through the Access-gated hostname.

**Services.** `cloudflared.service` (running). `admin.service` — the site: the
release binary built in the deploy checkout (`~/vps/dashboard`), run on port
3000 as a systemd user unit, with logs in journald. The unit pins `PORT=3000`
and `LOG_LEVEL=info`; any `config.rs` knob can be overridden for the host in
`~/.config/admin/env`, which the unit reads last.

Registration on this host (already done):

```bash
mkdir -p ~/.config/systemd/user
ln -sfn /home/dev/vps/tools/admin.service ~/.config/systemd/user/admin.service
systemctl --user daemon-reload
systemctl --user enable --now admin.service

# upgrade: pull into the deploy checkout, rebuild, restart
cd /home/dev/vps && git pull
cd dashboard && cargo build --release
systemctl --user restart admin.service

# inspect
systemctl --user status admin.service
journalctl --user -u admin.service -f
```

The unit file lives in the repo and is symlinked into `~/.config/systemd/user/`,
so the host registration is never hand-edited and a deploy needs no runtime
installed.

**Where the repo lives.** Development happens in `~/projects/vps`, on `main`.
The deploy checkout is `~/vps`, tracking `main`. It has to stay a checkout: the
site unit and the screenshots units are symlinked out of `~/vps/tools/`.

**Skills.** Skills in `skills/` are registered as symlinks in both skill
directories, so pi (via `~/.agents/skills`) and Claude Code (via
`~/.claude/skills`) both see them — the same way the systemd units are
symlinked to `~/vps/tools/`. Two ship today: `publish-page` (publish a throwaway
page at `/s/<slug>/` for the owner to look at) and `review-dev-site` (put a dev
server on port 4173 behind `dev.christophermeyer.dev` for a review).
Registration on this host (already done):

```bash
ln -sfn /home/dev/vps/skills/<name> ~/.agents/skills/<name>
ln -sfn /home/dev/vps/skills/<name> ~/.claude/skills/<name>
```

### Screenshots inbox

The Mac screenshot tool scps captures to `/home/dev/screenshots`
(`SCREENSHOTS_DIR` overrides). `tools/prune-screenshots.sh` deletes captures
older than 7 days (`SCREENSHOTS_RETENTION_DAYS` overrides) and exits quietly
when the inbox does not exist. It is driven by a daily systemd user timer, so
it fires without a login. Registration on this host (already done):

```bash
mkdir -p ~/.config/systemd/user
ln -sfn /home/dev/vps/tools/prune-screenshots.service ~/.config/systemd/user/
ln -sfn /home/dev/vps/tools/prune-screenshots.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now prune-screenshots.timer

# inspect
systemctl --user status prune-screenshots.timer
journalctl --user -u prune-screenshots.service
```

Those symlinks point into the `~/vps` checkout — do not remove that directory
or rename `tools/prune-screenshots.*` or `tools/admin.service` without
re-registering them.
