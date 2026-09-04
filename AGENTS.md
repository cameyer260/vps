# AGENTS.md

Context and invariants for any AI working in this repo. The dashboard in
particular is designed around the VPS setup described here — read this before
making changes. Deeper reference: [docs/vps.md](docs/vps.md) (host
environment) and [docs/jarvis.md](docs/jarvis.md) (the jarvis contract).

## VPS

- Hostinger VPS, Ubuntu 24.04.4 LTS, 2 AMD EPYC vCPUs, ~8 GB RAM, 100 GB disk.
- All routine work runs as the unprivileged `dev` user; `root` is only for
  host-level administration. Everything here must run as `dev` too.
- Network access is locked down: the Hostinger firewall drops all inbound
  public traffic, and UFW only permits SSH over the `tailscale0` interface.
  The only way the dashboard is reachable from the internet is via a
  Cloudflare tunnel to localhost.
- Docker Engine + Compose plugin are installed; `dev` is in the `docker`
  group (no sudo needed). systemd lingering is enabled for `dev`, so any
  long-running process should be a systemd user service or a container.
- Credentials live on the host and are mounted into containers at runtime —
  never baked into images (table in [docs/vps.md](docs/vps.md)).

## jarvis (how agents actually run)

`jarvis` (`agent-images/jarvis.sh`, symlinked onto the VPS PATH at
`~/bin/jarvis`) wraps `docker run` for pi agents (the
`@earendil-works/pi-coding-agent` CLI) inside containers built from the
`agent-pi` image. [docs/jarvis.md](docs/jarvis.md) is the single source of
truth for its behavior — the dashboard shells out to it and never re-derives
the flags. Rules:

- The dashboard starts agents **only** by shelling out to `jarvis rpc`. It
  uses the Docker API only to list/inspect/attach/stop containers.
- Discover agents via labels — `agent.kind=pi` (all agents),
  `agent.project=<basename>`, `agent.origin=dashboard` (dashboard-managed) —
  **never by container name** (containers get no `--name`; multiple agents
  can run on one project concurrently).
- Never mount `/home/dev` wholesale or the Docker socket into agent
  containers.
- Workspaces mount at their real host path (not `/workspace`) and the host
  sessions dir is mounted rw, so sessions group together and resume works
  across dashboard and SSH/TUI runs.
- Missing workspaces are pre-created by jarvis (`mkdir` + `git init` as
  `dev`) before a container mounts them — plain Docker `-v` would create
  them root-owned.
- Dev UID/GID for `--user` resolve as `${AGENT_UID:-$(id -u dev)}`; the
  dashboard container is deployed with `AGENT_UID`/`AGENT_GID` set (there is
  no dev user inside it to look up) and they are inherited by every jarvis
  invocation.
- Models are accessed through the OpenRouter provider.
- Agent containers hold **no GitHub credentials**. Remote git ops
  (push/fetch/pull) go through the host-side git bridge
  (`tools/jarvis-git-bridge.*`, systemd user socket; see docs/jarvis.md) —
  the bridge derives the workspace from the container's own mounts, so an
  agent can only ever act on the workspace it was launched with.
- The notes project lives at `/home/dev/notes` (a git repo synced with
  GitHub). It is the default/always-on agent's workspace.

## How the docs are organized

- `README.md` files — orientation and operations (what it is, how to
  run/build/deploy).
- `AGENTS.md` (this file) — invariants for AI agents.
- `docs/` — technical reference (VPS environment, jarvis contract).
- `dashboard/ARCHITECTURE.md` — dashboard internals (bridge, events socket,
  read-only mode, roadmap).
- Each fact is documented in exactly one place; link instead of duplicating.