# dashboard

Web application for managing pi agents ("jarvis" containers) on the VPS:
agent lifecycle management, a ChatGPT-like chat UI, and an Obsidian-like notes
viewer. Runs on the VPS in Docker, reached via Cloudflare tunnel (Cloudflare
Access handles auth; the app has none).

Read the [root README](../README.md) for VPS/jarvis context.

## Status

Built. The three original phases shipped:

1. **Core loop** — jarvis `rpc` subcommand, Docker attach, streaming chat UI,
   session persistence + resume.
2. **Notes section** — pinned notes UI, read-only mode, git pull on start,
   close-time commit guard, commit/push skill.
3. **Notes viewer** — Obsidian-style markdown viewer/editor.

## Architecture

    Browser (phone/desktop)
      │ HTTPS via Cloudflare tunnel + Access
      ▼
    dashboard container (Node/TypeScript, Hono)
      ├─ serves React SPA (Vite build)
      ├─ starts agents by shelling out to `jarvis rpc`
      ├─ Docker API (dockerode): list / inspect / attach / stop containers,
      │    plus the daemon's event stream (container lifecycle → /ws/events)
      ├─ WebSocket per open chat, relays pi RPC JSONL both ways
      ├─ global events WebSocket (/ws/events): agent list push, no polling
      └─ host-side git operations (pull / add / commit / push; remotes auth
         via the gh CLI credential helper)

    agent container (agent-pi image)
      └─ pi --mode rpc, JSONL over stdin/stdout, dashboard extension loaded

### jarvis is the single source of truth for container creation

The dashboard never builds `docker run` statements itself. `jarvis.sh` has an
`rpc` subcommand:

    jarvis rpc PROJECT [pi args...]
      → same flags as every mode (workspace at real host path, skills ro,
        auth, settings ro, bx.env, labels, dev UID), plus:
        - `docker run -d -i`, never `-t`: stdin stays open so the dashboard
          can attach and send prompts later; a TTY corrupts pi's LF-framed
          JSONL protocol
        - main process is `pi --mode rpc -a` (long-lived JSONL daemon)
        - loads the dashboard's read-only extension via `pi -e <path>`
          (dashboard/pi-extension/read-only.ts, mounted ro)
        - env `PI_DASHBOARD_READONLY=1` is passed into the container when set
          in the caller's environment (the start dialog's read-only checkbox)
        - extra label `agent.origin=dashboard` (what the dashboard filters on)
      → prints the container ID on stdout

The dashboard then uses the Docker API only to list/inspect/attach/stop.
TUI/one-shot jarvis usage is unchanged. Workspace autocreate (mkdir +
`git init`) lives in jarvis, so it happens exactly once for CLI and
dashboard-launched agents alike. The dev UID/GID resolve as
`${AGENT_UID:-$(id -u dev)}` — the dashboard container is deployed with
`AGENT_UID`/`AGENT_GID` set (there is no dev user inside it to look up).

### WS→RPC bridge (server/bridge.ts)

One bridge per agent container owns the docker attach stream and fans traffic
out to any number of browser WebSockets:

- Browser commands are rewritten with an internal request id; responses are
  routed back to the requesting client by id (original id restored). Events
  (no id) broadcast to everyone.
- Agent status (idle/streaming) derives from `agent_start`/`agent_settled`.
- pi `extension_ui_request` **notifies** are relayed fire-and-forget. The
  read-only extension announces mode changes that way; the bridge parses
  those, caches the last observed read-only state and sends it to new clients
  in `hello` (notifies are transient, so a tab connecting after a toggle
  would otherwise never learn the mode). Blocking dialog requests
  (`select`/`confirm`/`input`/`editor`) are dropped — nothing answers them
  headlessly.
- Successful state-mutating commands (`set_model`, `set_thinking_level`,
  `set_session_name`) refresh the bridge's cached state and are broadcast as
  a state notice to every client of that bridge, so all tabs of a chat stay
  in sync. The `hello` message carries the cached state (model / thinking
  level / session name / read-only mode) for an instant correct header on
  reconnect; clients still send their own `get_state` right after connecting
  as the authoritative refresh.
- Status transitions are also relayed onto the global events socket
  (`/ws/events`) — see below.
- Browser disconnects never stop the agent. On (re)connect the client
  backfills history via `get_entries` with a cursor (last entry id); items
  rendered from live events are provisional and get replaced by committed
  entries on backfill, so reconnects neither duplicate nor lose content.
- Agents run with no approval gating — the container boundary is the
  safeguard (isolated container, single project mount, no host access).

### Global events socket (server/events.ts, /ws/events)

The agent list is push-based; there is no polling:

- The server subscribes to the Docker daemon's event stream (`getEvents()`,
  filtered to `agent.kind=pi` containers, actions start/die/destroy/rename)
  and broadcasts `agents_changed`; clients resync with a debounced refetch of
  `GET /api/agents`. The subscription resubscribes after daemon restarts.
- Per-agent bridges relay idle/streaming/exited transitions onto the same
  socket as `agent_status`, so cards update in place.
- Clients keep a one-shot initial `GET /api/agents` fetch plus a refetch on
  (re)connect as the fallback/resync path.

### Read-only mode (dashboard/pi-extension/read-only.ts)

Loaded into every dashboard-started agent via `pi -e`. Enforcement lives in
the harness, never in the conversation (same pattern as Claude Code plan mode
or opencode permissions):

- `PI_DASHBOARD_READONLY=1` at load → starts read-only. Nothing sets this by
  default any more — new conversations start with full tools; the checkbox in
  the start dialog opts in.
- `/read-only on|off` toggles mid-session; the chat UI's toggle sends it as an
  RPC `prompt` (pi executes extension commands immediately, even mid-turn).
  The extension notifies on every change; those notifies are the UI button's
  ground truth (relayed by the bridge, cached in `hello`) — no per-device
  localStorage memory.
- **on:** `edit`/`write` are removed from the active toolset; a `tool_call`
  handler screens bash against a denylist of mutating patterns (redirects,
  rm/mv/sed -i/tee, mutating git subcommands, ...). Blocked calls return the
  reason as the tool result and the model self-corrects — it is never told to
  "behave read-only" in chat.
- **off:** full toolset restored.

Bash screening is a policy layer, not a security boundary. The hard guarantee
is container isolation.

## Features

### 1. Agents dashboard
Running dashboard agents grouped into sections by project; the notes project
is pinned at the top with a one-click "new conversation" (git pull first,
full tools). Cards update live via the `/ws/events` socket (see above). Each
card shows session name, model, status and uptime, with terminate (stop +
remove). Start dialog: pick a project (existing or new — autocreated by
jarvis with mkdir + git init) and a conversation (new, or resume from pi's
session store including SSH-created sessions); a read-only checkbox opts into
a chat-only session (default off). Model and thinking level are switched in
the chat UI and broadcast to every open tab.

### 2. Notes section (pinned)
Notes agents are agents on `/home/dev/notes`, managed like every other
project. Multiple conversations at once; sessions persist and can be resumed.
Every notes-agent start does a host-side `git pull` first — failures are
surfaced with copy-to-clipboard (hand them to an agent) and a "start anyway"
override. Closing an agent with a dirty notes tree warns: "close anyway" or
"commit & push, then close". Git policy is use-at-your-own-risk (no locks);
agents are instructed to stage-commit-push after changes via the
`commit-push` skill (dashboard/skills/commit-push — symlink into `~/.agents`):

    ln -sfn /home/dev/vps/dashboard/skills/commit-push ~/.agents/skills/commit-push

### 3. Chat UI (per agent)
ChatGPT-style: streaming markdown responses, composer with a single send/stop
button (no steering — while a turn runs the composer doesn't send; Enter is
ignored until the turn settles), collapsible tool-call activity, thinking
blocks, model / thinking-level switching (`set_model`, `set_thinking_level`,
fanned out to all tabs), read-only toggle driven by the agent's own notifies.

### 4. Notes viewer
Obsidian clone over `/home/dev/notes`: file tree, multiple files open as tabs,
rendered view + raw edit toggle (edits auto-save), full-text search. Opening
the viewer does a host-side `git pull` (errors surfaced with copy, retry,
dismiss). "Commit & push" stages exactly the files edited in that viewer
session — dirt from agents isn't swept up.

## Deployment (UID/GID quirk)

The dashboard runs inside a container but must act as the host `dev` user (git
pulls/commits must be dev-owned) and reach the Docker socket. All identity
values are resolved on the host at deploy time — never hardcoded, never looked
up inside the container. The runtime image (dashboard/Dockerfile) installs the
docker CLI, git and gh; `dashboard/deploy.sh` does the rest:

```bash
docker run -d \
  --restart unless-stopped \
  --user "$(id -u dev):$(id -g dev)" \
  --group-add "$(getent group docker | cut -d: -f3)" \
  -e AGENT_UID="$(id -u dev)" \
  -e AGENT_GID="$(id -g dev)" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /home/dev/vps:/home/dev/vps:ro \
  -v /home/dev/projects:/home/dev/projects \
  -v /home/dev/notes:/home/dev/notes \
  -v /home/dev/.pi/agent/sessions:/home/dev/.pi/agent/sessions \
  -v /home/dev/.gitconfig:/home/dev/.gitconfig:ro \
  -v /home/dev/.config/gh:/home/dev/.config/gh:ro \
  -p 127.0.0.1:3000:3000 \
  dashboard
```

- `--user`: files the dashboard creates (git operations, agent starts via
  jarvis) are dev-owned on the host.
- `--group-add <host docker gid>`: without it the container's user can't read
  `/var/run/docker.sock` (it's `root:docker` on the host).
- `AGENT_UID`/`AGENT_GID`: inherited by every `jarvis rpc` invocation so agent
  containers get the correct `--user`.
- `/home/dev/vps` ro: jarvis.sh + the pi extension, mounted at their canonical
  path (jarvis resolves the extension relative to its own location).
- `/home/dev/projects` + `/home/dev/notes` rw: git operations, project
  listing, notes viewer.
- `/home/dev/.pi/agent/sessions`: session listing + resume.
- `/home/dev/.gitconfig` ro: git identity for the commits the dashboard makes,
  plus the `credential.helper` line pointing git at gh.
- `/home/dev/.config/gh` ro: gh CLI auth for git remotes (OAuth token in
  `hosts.yml`). Tokens don't expire under normal use, so the read-only mount
  needs no re-auth; re-authing on the host + a container restart picks up a
  new token. There is no `~/.ssh` mount.
- `-p 127.0.0.1:...`: the only route in is the Cloudflare tunnel to localhost.

On the VPS:

    cd /home/dev/vps/dashboard && ./deploy.sh      # HOST_PORT=3000 default

Once, symlink the commit/push skill into the agents' skills dir:

    ln -sfn /home/dev/vps/dashboard/skills/commit-push ~/.agents/skills/commit-push

Cloudflared should point at `http://localhost:$HOST_PORT`.

## Development (Mac)

```bash
cd dashboard
npm install
npm run dev:server   # Hono on :3000 (Docker/jarvis paths are VPS-only; APIs fail gracefully)
npm run dev:web      # Vite on :5173, proxies /api + /ws to :3000
```

Builds: `npm run build` (Vite SPA → dist/, esbuild server bundle →
dist-server/). The bundle stubs out ssh2 (dockerode's optional native dep —
the dashboard only talks to the unix socket) so the runtime image needs no
node_modules. Typecheck: `npm run typecheck`.

## Future improvements

- **Image/file attachments** in chat (`prompt` already accepts images).
- **Delete sessions from the UI.**
- **IDE mode** — extend the notes viewer to more file formats for looking at
  coding projects.
- **Voice mode** — push-to-talk conversation with the notes agent.
