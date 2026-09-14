# host pi — bare-metal dashboard agents (no jarvis/container)

The dashboard's second spawn path. Jarvis agents (see
[docs/jarvis.md](jarvis.md)) run `pi --mode rpc` inside Docker containers;
**host agents** run the same `pi --mode rpc -a` directly on the VPS as `dev`,
with their working directory anywhere under `/home/dev`. Same chat UI, same
bridge framing — full host permissions instead of container isolation.

**This file is the single source of truth for host-agent behavior**, like
`docs/jarvis.md` is for containers.

## Why

Some work genuinely needs the host: VPS maintenance, dotfiles, services,
repos outside `/home/dev/projects`, anything the container mount list doesn't
cover. Host agents trade the container boundary for that reach — they run
with full `dev` permissions and no read-only extension.

## Components

| Piece | Path |
|---|---|
| Supervisor (owns every host pi child) | `tools/pi-host-supervisor.mjs` (node, builtins only) |
| systemd user unit | `tools/pi-host-supervisor.service` |
| Dashboard client | `dashboard/server/host-supervisor.ts` |
| Runtime backend | `dashboard/server/runtime-host.ts` (behind `server/runtime.ts`) |
| Dir validation | `dashboard/server/config.ts:resolveHostDir()` |

## Supervisor

Long-running user service — **not** socket-activated per-connection (unlike
`jarvis-git-bridge`, whose handlers are one-shot). It `spawn()`s each pi
child directly, holds its stdio pipes, and proxies bytes to dashboard attach
connections. Parenthood is the point:

- Dashboard redeploys kill nothing (dashboard is only a client over the socket).
- Supervisor stop/restart kills all host agents with it
  (`KillMode=control-group` + explicit SIGTERM→SIGKILL sweep) — host agents
  are never orphaned/reparented to init.
- Crash leftovers are swept on boot via pidfiles in
  `~/.local/state/pi-host-supervisor/*.pid` (SIGTERM stale pids, unlink).

Socket: `/run/user/1000/pi-host-supervisor.sock` (override with
`PI_HOST_SUPERVISOR_SOCK`). The dashboard container mounts it (see
`dashboard/deploy.sh`), same pattern as the git-bridge socket.

Protocol: newline-delimited JSON, one request line per connection (see the
header comment in `tools/pi-host-supervisor.mjs` for the full op list:
`ping` / `list` / `spawn` / `kill` / `logs` / `attach` / `subscribe`).
`attach` switches its connection to raw proxy mode after `{"ok":true}`;
multiple attaches fan out (each gets a full stdout copy, any input goes to
pi stdin). `subscribe` streams `{"action":"start|die|destroy","id":...}`.

## Whitelist

Enforced twice (dashboard route + supervisor, same rule):

- `cwd`: absolute, must exist, must be a directory, realpath must sit inside
  the dev home dir (`HOME_DIR`/`HOME`, default `/home/dev`). No autocreate —
  host dirs are an explicit choice, unlike jarvis workspaces. No shell —
  argv spawn only.
- `sessionPath` (resume): absolute, under the pi sessions dir
  (`PI_SESSIONS_DIR`, default `/home/dev/.pi/agent/sessions`), ending `.jsonl`.
- Fixed pi argv only: `pi --mode rpc -a [--session F] [-n NAME]
  --append-system-prompt HOST_CONTEXT`. No `--provider`/`--model` passthrough
  (pick the model in the chat UI), no read-only extension, no General Chat.

## Dashboard mapping

- `AgentInfo`: `runtime: "jarvis" | "host"`, plus `directory` (full path) for
  host agents; `project` stays the basename so grouping/sort keep working.
  Host ids are `host-<ts>-<seq>` (never collide with container hex ids).
- `POST /api/agents/start` takes `runtime: "host"` + `directory`; jarvis
  fields (`project`, `readOnly`) are ignored/rejected there.
- `GET /api/host-validate?path=` powers the New Agent modal's green/red dot.
- `GET /api/sessions?directory=` feeds the conversation picker in host mode.
- `/ws/agent/:id` and terminate work unchanged (runtime routes by id prefix).
- Host agents hide the read-only toggle (no extension loaded) and show a
  `host` pill + full-path notice instead of the container scoping line.

## Operations (as dev)

```bash
# install once:
mkdir -p ~/.config/systemd/user
ln -sfn /home/dev/vps/tools/pi-host-supervisor.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pi-host-supervisor.service

# inspect:
systemctl --user status pi-host-supervisor.service
journalctl --user -u pi-host-supervisor.service -f
ls /run/user/$(id -u)/pi-host-supervisor.sock
```

Prerequisites: the unit pins `PI_BIN` to the absolute nvm pi path and
prepends the same nvm `bin/` to `PATH` (plain `pi`/`node` on systemd's
default PATH resolve to node v18, while pi 0.85+ needs node 22+ — spawning
without this fails every host agent; update the pin if the node version
changes, and note the supervisor launches pi via its own node binary so the
daemon itself never depends on PATH). A spawn whose child fails to start
returns `ok: false` instead of a ghost id, and the service logs a `WARNING`
at boot when `PI_BIN` isn't executable.
Lingering already enabled (AGENTS.md). Stopping the service stops all
host agents; the dashboard list drops them via the `die`/`destroy` events.

## Isolation tradeoff (explicit)

Jarvis: isolated container, one project mount, no host creds — the boundary
*is* the safeguard. Host: full `dev` user — can read `~/.config/gh`,
rewrite anything in `/home/dev`, touch services. The Agents tab marks these
with a `host` pill; the chat shows the full directory. Don't use host mode
for untrusted tasks.
