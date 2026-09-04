# VPS environment

Reference for the host this monorepo runs on. Agent-facing rules live in
[AGENTS.md](../AGENTS.md).

## Hardware & OS

- Hostinger VPS, Ubuntu 24.04.4 LTS, 2 AMD EPYC vCPUs, ~8 GB RAM, 100 GB disk.
- Routine work runs as the unprivileged `dev` user; `root` is only for
  host-level administration.
- systemd lingering is enabled for `dev`, so user services persist across
  logouts — long-running processes should be systemd user services or
  containers. tmux is available for interactive work.
- Docker Engine + Compose plugin are installed; `dev` is in the `docker`
  group (no sudo needed for docker).

## Network

- The Hostinger firewall drops all inbound public traffic.
- UFW only permits SSH over the `tailscale0` interface (Tailscale).
- The dashboard's only route from the internet is a Cloudflare tunnel to
  `localhost` on the VPS; Cloudflare Access handles auth.

## Credentials on the host

Never baked into images — mounted or passed in at runtime:

| Path | Purpose | How it reaches containers |
|---|---|---|
| `/home/dev/.pi/agent/auth.json` | pi auth tokens | mounted rw so refreshed sessions persist on the host |
| `/home/dev/.agents` | agent skills | mounted read-only |
| `/home/dev/.config/bx/bx.env` | Brave Search API key | `--env-file` |
| `/home/dev/.pi/agent/settings.json` | shared pi defaults (provider/model/thinking) | mounted read-only so agents can't rewrite host settings |
| `/home/dev/.config/gh` | gh CLI auth (GitHub OAuth token in `hosts.yml`) | mounted read-only into the dashboard container so its git operations can push/pull remotes |
| `/home/dev/.gitconfig` | git identity + `credential.helper` pointing at gh | mounted read-only into the dashboard container |
| `/home/dev/.cache/ms-playwright/` | Playwright Chromium bundle | baked into the base image at build time (BuildKit context) — see [agent-images/README.md](../agent-images/README.md) |

Create the bx env file once on the VPS as `dev`:

```bash
mkdir -p /home/dev/.config/bx
printf 'BRAVE_SEARCH_API_KEY=thekey\n' > /home/dev/.config/bx/bx.env
chmod 600 /home/dev/.config/bx/bx.env
```

You log into Pi once with the auth mounts; the Brave key is the env file.

## Directory layout on the host

| Path | What |
|---|---|
| `/home/dev/vps` | this monorepo (clone of `cameyer260/vps`) |
| `/home/dev/projects` | agent workspaces (override with `AGENT_PROJECTS_DIR`) |
| `/home/dev/notes` | the notes project — a git repo synced with GitHub; the default/always-on agent's workspace |
| `/home/dev/.pi/agent/sessions` | pi session store, shared between dashboard and SSH/TUI runs |
| `~/bin` | symlinks: `jarvis` → `agent-images/jarvis.sh`, `build-images.sh` → `agent-images/build-images.sh` |