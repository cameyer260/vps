# Requested dashboard changes

Collected from review of the phase 1–3 implementation. Not yet implemented.

Implement in three commits (in this order):

1. **`deploy: git auth via gh CLI, drop ~/.ssh mount`** — changes #4 + #5.
   Only touches `deploy.sh`/Dockerfile; independently revertable, no code
   overlap with the rest.
2. **`chat: read-only default off + notify-driven toggle, single send/stop
   button, remove dialog handling`** — changes #1 + #2 + #3 + #6. All the
   chat-session behavior changes; #6 is here because its surviving `notify`
   pass-through is exactly what #2 builds on, so the same bridge routing code
   is only touched once.
3. **`feat: push live state to clients (agent events, model/thinking
   fan-out)`** — changes #7 + #8. Both replace stale/polling state with push:
   the global events WebSocket for agent cards, and bridge broadcast +
   `hello` handshake for model/thinking/session state.
4. **`docs: update documentation for all dashboard changes`** — change #9.
   Sweep over README, deployment notes, and any architecture/runbook docs;
   must land last since it documents the final behavior of commits 1–3.

## 1. Read-only default off

New notes conversations should start with full tools (read/write enabled).
The read-only toggle is off by default; the user flips it on when they want a
chat-only/ask-only session. Applies to both the start dialog checkbox (notes)
and the one-click "new conversation" button.

## 2. Remove the localStorage toggle memory

The chat's read-only toggle currently persists its position per container in
browser localStorage — per-device memory that can go stale. Instead the toggle
should reflect the agent's actual state:

- The read-only extension emits a `notify` message whenever the mode changes
  ("read-only mode on/off"), and the bridge broadcasts those to the chat UI.
  The button state follows those as ground truth instead of localStorage.
- Notify messages are transient, so the bridge also **caches the last known
  read-only state** it observed and sends it to newly connecting clients —
  otherwise a tab that opens after a toggle would have no way to learn the
  current mode. On connect the button starts from the start-time default
  (off, per change #1) and is corrected by the cached state if there is one.

## 3. Single send/stop button, no steer

One composer button: send arrow when idle, stop square while streaming
(ChatGPT-style). Remove the steer feature entirely (button and Enter-based
steer) — while a turn is running the composer does not send; Enter is ignored
until the turn settles.

## 4. Drop the `~/.ssh` mount

Remove the optional `~/.ssh:ro` mount from `deploy.sh`. Git remotes
authenticate via gh CLI, not SSH keys.

## 5. Git auth via gh in the dashboard container

Installing gh alone is not enough — its OAuth token lives in
`~/.config/gh/hosts.yml`. So:

- install `gh` in the dashboard image (Dockerfile), and
- mount `~/.config/gh` read-only into the container in `deploy.sh`.

Keep the `~/.gitconfig` mount: it provides the commit identity
(`user.name`/`user.email`) and the `credential.helper` line that points git
at gh. gh OAuth tokens don't expire under normal use, so a read-only mount
needs no re-auth; re-authing on the host + container restart picks up a new
token.

## 6. Remove extension UI dialog handling from the bridge

Delete the blocking-dialog machinery (`select`/`confirm`/`input`/`editor`
requests, the 120s auto-cancel timers, dialog routing) — extra complexity for
a path nothing currently uses. **Keep the `notify` pass-through** (one-line
fire-and-forget broadcast): the read-only toggle's on/off confirmations use
it, and it is the ground-truth signal for change #2.

## 7. Real-time agent list — replace polling

Replace the 4-second `GET /api/agents` polling in the UI with push:

- A global events WebSocket (e.g. `/ws/events`).
- Server subscribes to the Docker daemon's event stream (dockerode
  `getEvents()`) for container start/die/destroy/rename → card add/remove and
  state changes become instant.
- Per-agent bridges already broadcast idle/streaming transitions; relay those
  onto the global socket so cards show live status without polling.
- Client keeps a one-shot initial `GET /api/agents` fetch plus a refetch on
  reconnect as the fallback/resync path.

## 8. Fan out model/thinking changes to all tabs of a chat

When one tab switches model or thinking level, other tabs viewing the same
chat keep a stale value in their header pickers until reconnect. The bridge
is already the choke point for every command/response, so:

- **Broadcast**: when the bridge routes a successful `set_model` /
  `set_thinking_level` / `set_session_name` response, it also broadcasts a
  small state notice to all clients of that bridge. The data is free —
  `set_model`'s response carries the full model object, and the bridge saw
  the requested level in the command it forwarded.
- **Update the bridge cache**: the same hook refreshes the bridge's cached
  state (model / thinkingLevel / sessionName) on those responses, so the
  cache no longer goes stale after a mid-session switch.
- **Connect handshake**: the `hello` message sent to every new client includes
  the cached state, so a reconnecting tab renders a correct header instantly.
  The client still sends its own `get_state` right after connecting as the
  authoritative refresh (covers state changes the bridge never observed,
  e.g. something inside the conversation altering the model — there is no
  RPC event for that). Cache for speed, `get_state` for truth.

## 9. Documentation update

Sweep all project documentation so it matches the behavior after changes
#1–#8. In particular:

- Read-only default is now off; toggle state is per-session from the agent
  (notify broadcast), not persisted in localStorage.
- Composer has a single send/stop button; the steer feature no longer exists.
- Extension UI dialogs (`select`/`confirm`/`input`/`editor`) are gone from the
  bridge; the `notify` pass-through remains.
- Git auth in the dashboard container is via gh CLI (`~/.config/gh` mount);
  there is no `~/.ssh` mount.
- Agent list is push-based via the global events WebSocket (`/ws/events`),
  not 4-second polling.
- Model/thinking/session state is broadcast by the bridge and included in the
  `hello` handshake.

Also remove any docs-only references to removed features (steer, dialog
requests, polling interval, ssh mount) rather than just editing around them.
