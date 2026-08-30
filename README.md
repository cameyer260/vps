# vps

Monorepo for everything agent-related on my VPS:

- **`agent-images/`** — Dockerfiles, the `jarvis` wrapper script, and build tooling for running pi agents in containers on the VPS.
- **`dashboard/`** — web application for managing those agents (agent lifecycle, ChatGPT-like chat UI, Obsidian-like notes viewer). See its README for the Phase 9 plan.

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

Key behaviors of jarvis that the dashboard must mirror or invoke:

- `jarvis PROJECT [TASK]`:
  - With no TASK: interactive pi TUI (`docker run -it ... pi -a`).
  - With TASK: one-shot mode (`docker run -i ... pi -p --approve "$@"`), prints the response and exits. Extra args (e.g. `--provider`, `--model`) are forwarded to pi as-is.
- PROJECT is a bare name resolved under `/home/dev/projects` (override with `AGENT_PROJECTS_DIR`) or an absolute path. Missing workspaces are pre-created with `mkdir` as `dev` (plain Docker `-v` would create them root-owned, which breaks the container's dev user). **When starting new agents/projects, the dashboard must do the same pre-creation, plus `git init`.**
- Container run flags (the canonical docker run statements are in `agent-images/docker-run.md`):
  - `--rm`, `--user "$(id -u dev):$(id -g dev)"`
  - `-v <project>:/workspace` (project bind mount), `-w /workspace`
  - `-v /home/dev/.agents:/home/dev/.agents:ro` (skills)
  - `-v /home/dev/.pi/agent/auth.json:/home/dev/.pi/agent/auth.json` (pi auth)
  - `--env-file /home/dev/.config/bx/bx.env`
  - labels: `agent.kind=pi`, `agent.project=<project-basename>` (no `--name` — multiple agents can run on one project concurrently; the dashboard should discover agents via `docker ps --filter label=agent.kind=pi` and read the project from the label, not from container names)
- Models are accessed through the OpenRouter provider.
- `jarvis projects` lists host projects; `jarvis build` rebuilds the images.

The notes project lives at `/home/dev/notes` (a git repo, synced with GitHub). It is the default/always-on agent's workspace.

### Implications for the dashboard

- The dashboard talks to the Docker daemon (as `dev`, via the docker group or a socket mount) to list/start/stop agent containers — effectively a web UI over jarvis's `docker run` statements.
- It must not mount `/home/dev` wholesale or the Docker socket into agent containers.
- New projects must be created dev-owned with git initialized before the container mounts them.
- Real-time chat UI (dashboard Phase 9 item 2) requires relaying to/from headless pi instances — open design question: watch pi session history files vs. streaming directly from the pi process.
