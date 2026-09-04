# dashboard

Web application for managing pi agents ("jarvis" containers) on the VPS:
agent lifecycle management, a ChatGPT-like chat UI, and an Obsidian-like
notes viewer. Runs on the VPS in Docker, reached via Cloudflare tunnel
(Cloudflare Access handles auth; the app has none).

Agent context: [AGENTS.md](../AGENTS.md) · How it works inside:
[ARCHITECTURE.md](ARCHITECTURE.md) · The jarvis contract it relies on:
[../docs/jarvis.md](../docs/jarvis.md)

## Status

Built and running on the VPS — see Deployment.

## Features

### 1. Agents dashboard
Running dashboard agents grouped into sections by project; the notes project
is pinned at the top with a one-click "new conversation" (git pull first,
full tools). Cards update live via the `/ws/events` socket (see
[ARCHITECTURE.md](ARCHITECTURE.md)). Each card shows session name, model,
status and uptime, with terminate (stop + remove). Start dialog: pick a
project (existing or new — autocreated by jarvis with mkdir + git init) and a
conversation (new, or resume from pi's session store including SSH-created
sessions); a read-only checkbox opts into a chat-only session (default off).
Model and thinking level are switched in the chat UI and broadcast to every
open tab.

### 2. Notes section (pinned)
Notes agents are agents on `/home/dev/notes`, managed like every other
project. Multiple conversations at once; sessions persist and can be resumed.
Every notes-agent start does a host-side `git pull` first — failures are
surfaced with copy-to-clipboard (hand them to an agent) and a "start anyway"
override. Closing an agent with a dirty notes tree warns: "close anyway" or
"commit & push, then close". Git policy is use-at-your-own-risk (no locks);
agents are instructed to stage-commit-push after changes via the
`commit-push` skill (`dashboard/skills/commit-push`, symlinked into
`~/.agents` — see Deployment).

### 3. Chat UI (per agent)
ChatGPT-style: streaming markdown responses, composer with a single send/stop
button (no steering — while a turn runs the composer doesn't send; Enter is
ignored until the turn settles), collapsible tool-call activity, thinking
blocks, model / thinking-level switching (`set_model`, `set_thinking_level`,
fanned out to all tabs), and a read-only toggle that mirrors the agent's live mode.

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
  -v /home/dev/screenshots:/home/dev/screenshots \
  -v /home/dev/.pi/agent/sessions:/home/dev/.pi/agent/sessions \
  -v /home/dev/.config/bx/bx.env:/home/dev/.config/bx/bx.env:ro \
  -v /home/dev/.pi/agent/auth.json:/home/dev/.pi/agent/auth.json \
  -v /home/dev/.pi/agent/settings.json:/home/dev/.pi/agent/settings.json:ro \
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
- `/home/dev/screenshots` rw: the screenshots inbox the Mac tool scps to.
  jarvis (running inside this container) can pre-create it as dev so Docker
  never autocreates the host dir root-owned; agents get it read-only via
  the jarvis mount (see [../docs/vps.md](../docs/vps.md)).
- `/home/dev/.pi/agent/sessions`: session listing + resume.
- `/home/dev/.config/bx/bx.env` ro: Brave Search key — jarvis passes it via
  `--env-file`, which the docker CLI reads client-side, so the file must
  exist inside this container too (fatal to agent starts otherwise).
- `/home/dev/.pi/agent/auth.json` rw: pi auth for agents started here
  (jarvis mounts it into every agent; rw so refreshed tokens persist).
- `/home/dev/.pi/agent/settings.json` ro: shared pi defaults (provider/model).
- `/home/dev/.gitconfig` ro: git identity for the commits the dashboard makes,
  plus the `credential.helper` line pointing git at gh.
- `/home/dev/.config/gh` ro: gh CLI auth for git remotes (OAuth token in
  `hosts.yml`). Tokens don't expire under normal use, so the read-only mount
  needs no re-auth; re-authing on the host + a container restart picks up a
  new token.
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
