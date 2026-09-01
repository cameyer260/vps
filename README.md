# vps

Monorepo for everything agent-related on my VPS:

- **`agent-images/`** — Dockerfiles, the `jarvis` wrapper script, and build tooling for running pi agents in containers on the VPS.
- **`dashboard/`** — web application for managing those agents (agent lifecycle, ChatGPT-like chat UI, Obsidian-like notes viewer). Built — see its README for architecture, deployment and the jarvis `rpc` contract.

See the [Context](#context-the-vps-and-jarvis) section below before working in either subdirectory — the dashboard in particular is designed around the VPS setup described there.

## Context: the VPS and jarvis

Any AI working in this repo should understand the following before making changes.

### VPS

- Hostinger VPS, Ubuntu 24.04.4 LTS, 2 AMD EPYC vCPUs, ~8 GB RAM, 100 GB disk.
- All routine work runs as the unprivileged `dev` user; `root` is only for host-level administration. Everything here must run as `dev` too.
- Network access is locked down: the Hostinger firewall drops all inbound public traffic, and UFW only permits SSH over the `tailscale0` interface. The only way the dashboard is reachable from the internet is via a Cloudflare tunnel to `localhost` on the VPS.
- Docker Engine + Compose plugin are installed; `dev` is in the `docker` group (no sudo needed). tmux is available for interactive work. systemd lingering is enabled for `dev`, so user services persist across logouts — any long-running process should be a systemd user service or a container.
- Credentials on the host (never baked into images):
  - `/home/dev/.config/bx/bx.env` — Brave Search API key env file, passed to containers via `--env-file`.
  - `/home/dev/.pi/agent/auth.json` — pi auth tokens, mounted rw so refreshed sessions persist on the host.
  - `/home/dev/.agents` — agent skills, mounted read-only into containers.

### jarvis (how agents actually run)

`jarvis` is a bash wrapper (`agent-images/jarvis.sh`, symlinked onto the VPS PATH at `~/bin/jarvis`) around a `docker run` statement that launches **pi** (the `@earendil-works/pi-coding-agent` CLI) inside a container built from the `agent-pi` image (which stacks on a `base` image with Ubuntu 24.04, a non-root `dev` user, and CLIs the skills need: git, ripgrep, fd, jq, gh, bx).

Key behaviors of jarvis (the dashboard shells out to it — it never re-derives the flags):

- `jarvis PROJECT [TASK]`:
  - With no TASK: interactive pi TUI (`docker run -it ... pi -a`).
  - With TASK: one-shot mode (`docker run -i ... pi -p --approve "$@"`), prints the response and exits. Extra args (e.g. `--provider`, `--model`) are forwarded to pi as-is.
  - `jarvis rpc PROJECT [pi args...]`: detached `pi --mode rpc` daemon for the dashboard (labeled `agent.origin=dashboard`, prints the container ID).
- PROJECT is a bare name resolved under `/home/dev/projects` (override with `AGENT_PROJECTS_DIR`) or an absolute path. Missing workspaces are pre-created with `mkdir` **plus `git init`** as `dev` (plain Docker `-v` would create them root-owned, which breaks the container's dev user).
- Container run flags (the canonical docker run statements are in `agent-images/docker-run.md`):
  - `--rm`, `--user "${AGENT_UID:-$(id -u dev)}:${AGENT_GID:-$(id -g dev)}"` (the dashboard container deploys `AGENT_UID`/`AGENT_GID`; there is no dev user inside it to look up)
  - `-v <project>:<project>` (workspace at its **real host path**, workdir there — not `/workspace`), so sessions group with host pi runs
  - `-v /home/dev/.pi/agent/sessions:/home/dev/.pi/agent/sessions` (rw; sessions persist beyond `--rm` and are shared across dashboard and SSH/TUI)
  - `-v /home/dev/.agents:/home/dev/.agents:ro` (skills)
  - `-v /home/dev/.pi/agent/auth.json:/home/dev/.pi/agent/auth.json` (pi auth)
  - `-v /home/dev/.pi/agent/settings.json:/home/dev/.pi/agent/settings.json:ro` (shared defaults: provider/model/thinking level; read-only so agents can't rewrite host settings)
  - `--env-file /home/dev/.config/bx/bx.env`
  - labels: `agent.kind=pi`, `agent.project=<project-basename>` (no `--name` — multiple agents can run on one project concurrently; discover agents via labels, never container names)
- Models are accessed through the OpenRouter provider.
- `jarvis projects` lists host projects; `jarvis build` rebuilds the images.

The notes project lives at `/home/dev/notes` (a git repo, synced with GitHub). It is the default/always-on agent's workspace.

### Implications for the dashboard

The dashboard exists (`dashboard/`) and works as follows — its own README has
the details:

- It talks to the Docker daemon (via the socket, through the docker group) to
  list/inspect/attach/stop agent containers, but **starts agents by shelling
  out to `jarvis rpc`** — jarvis stays the single source of truth for the
  `docker run` flags.
- It must not mount `/home/dev` wholesale or the Docker socket into agent
  containers.
- New projects are created dev-owned with git initialized before the
  container mounts them — jarvis's `prepare_workspace()` does both.
- Real-time chat UI relays pi RPC JSONL between the browser and the container
  over WebSockets (one bridge per container); history backfills via
  `get_entries` on (re)connect.
- Agents are discovered via labels: `agent.kind=pi` (all agents),
  `agent.origin=dashboard` (dashboard-managed), `agent.project=<basename>`.
- Workspace mounts use real host paths and the host sessions dir is mounted
  rw, so sessions group together and resume works across dashboard and
  SSH/TUI runs.
