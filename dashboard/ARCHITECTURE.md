# dashboard architecture

How the dashboard works inside. Usage and deployment:
[README.md](README.md). The jarvis contract it shells out to:
[../docs/jarvis.md](../docs/jarvis.md).

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
      └─ git push/fetch/pull only via the host git-bridge socket
         (no GitHub credentials in the container — docs/jarvis.md)

## jarvis is the single source of truth for container creation

The dashboard never builds `docker run` statements itself. `jarvis.sh` has an
`rpc` subcommand — the full contract is documented in
[../docs/jarvis.md](../docs/jarvis.md). In short:

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
`git init`) lives in jarvis (`prepare_workspace()`), so it happens exactly
once for CLI and dashboard-launched agents alike. The dev UID/GID resolve as
`${AGENT_UID:-$(id -u dev)}` — the dashboard container is deployed with
`AGENT_UID`/`AGENT_GID` set (there is no dev user inside it to look up).

## WS→RPC bridge (server/bridge.ts)

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

## Global events socket (server/events.ts, /ws/events)

The agent list is push-based; there is no polling:

- The server subscribes to the Docker daemon's event stream (`getEvents()`,
  filtered to `agent.kind=pi` containers, actions start/die/destroy/rename)
  and broadcasts `agents_changed`; clients resync with a debounced refetch of
  `GET /api/agents`. The subscription resubscribes after daemon restarts.
- Per-agent bridges relay idle/streaming/exited transitions onto the same
  socket as `agent_status`, so cards update in place.
- Clients keep a one-shot initial `GET /api/agents` fetch plus a refetch on
  (re)connect as the fallback/resync path.

## Read-only mode (dashboard/pi-extension/read-only.ts)

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

## Future improvements

- **Image/file attachments** in chat (`prompt` already accepts images).
- **Delete sessions from the UI.**
- **IDE mode** — extend the notes viewer to more file formats for looking at
  coding projects.
- **Voice mode** — push-to-talk conversation with the notes agent.