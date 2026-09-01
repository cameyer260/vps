# dashboard

Web application for managing pi agents ("jarvis" containers) on the VPS:
agent lifecycle management, a ChatGPT-like chat UI, and an Obsidian-like notes
viewer. Runs on the VPS in Docker, reached via Cloudflare tunnel (Cloudflare
Access handles auth; the app has none).

Read the [root README](../README.md) for VPS/jarvis context.

## Goal

"ChatGPT on the go, with my notes as context, plus a control panel for headless
pi agents working on my projects." Responsive UI that works well on desktop and
phone; primarily used from a phone.

## Architecture

    Browser (phone/desktop)
      │ HTTPS via Cloudflare tunnel + Access
      ▼
    dashboard container (Node/TypeScript, Hono or Fastify)
      ├─ serves React SPA (Vite build)
      ├─ starts agents by invoking jarvis (see below)
      ├─ Docker API (dockerode): list / inspect / attach / stop containers
      ├─ WebSocket per open chat, relays pi RPC JSONL both ways
      └─ host-side git operations (pull / add / commit / push)

### Deployment (UID/GID quirk)

The dashboard runs inside a container but must act as the host `dev` user
(git pulls/commits must be dev-owned) and reach the Docker socket. All
identity values are resolved on the host at deploy time — never hardcoded,
never looked up inside the container:

```bash
docker run -d \
  --user "$(id -u dev):$(id -g dev)" \
  --group-add "$(getent group docker | cut -d: -f3)" \
  -e AGENT_UID="$(id -u dev)" \
  -e AGENT_GID="$(id -g dev)" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  ... dashboard
```

- `--user`: files the dashboard creates (git operations, agent starts via
  jarvis) are dev-owned on the host.
- `--group-add <host docker gid>`: without it, the container's user can't
  read `/var/run/docker.sock` (it's `root:docker` on the host).
- `AGENT_UID`/`AGENT_GID`: inherited by every `jarvis rpc` invocation so
  agent containers get the correct `--user` (see jarvis changes below).
  The dashboard never resolves UIDs itself and never passes them per-call.

### jarvis is the single source of truth for container creation

The dashboard does not duplicate the `docker run` flags. `jarvis.sh` gains an
`rpc` subcommand:

    jarvis rpc PROJECT [pi args...]
      → same flags as always (workspace, skills ro, auth, settings ro,
        bx.env, labels, dev UID), plus:
        - detached (`docker run -d`) so the dashboard can attach later
        - main process is `pi --mode rpc` (long-lived JSONL daemon)
        - extra label `agent.origin=dashboard` (what the dashboard filters on)
      → prints the container ID

The dashboard shells out to this, then uses the Docker API only to
list/inspect/attach/stop. TUI/one-shot jarvis usage is unchanged.

Related `agent-images` changes:

- `prepare_workspace()` also runs `git init` when the workspace has no
  `.git` — so project autocreate (mkdir + git init) happens exactly once,
  for CLI and dashboard-launched agents alike. (Today jarvis only mkdirs;
  git init was never implemented.)
- Workspaces are mounted at their **real host path**
  (`/home/dev/projects/foo:/home/dev/projects/foo`, workdir there) instead of
  `/workspace`, and `/home/dev/.pi/agent/sessions` is mounted rw at the same
  path — so sessions group under the same project as host pi sessions and
  "resume conversation" works across dashboard and SSH/TUI worlds.
- `AGENT_UID`/`AGENT_GID` env overrides for the dev UID. jarvis resolves
  them as `${AGENT_UID:-$(id -u dev)}`: unset (normal SSH use) → `id`
  lookup, exactly as today. The dashboard container is deployed with
  `AGENT_UID`/`AGENT_GID` set (the dashboard runs inside its own container,
  where `id -u dev` can't do the host lookup); jarvis inherits them from the
  dashboard's environment on every invocation.

### Chat relay

The dashboard attaches to the agent container's stdout and relays pi RPC
events (`message_update`/`text_delta`, tool execution, `agent_settled`, …)
to the browser over a WebSocket; browser input goes back as RPC commands
(`prompt`, `steer`, `abort`, `set_model`, …).

- Agent status (idle / streaming / awaiting) is derived from RPC events.
- Browser disconnects don't stop the agent. On reattach, history is
  backfilled via `get_entries` (cursor-based) and streaming resumes.
- Multiple tabs/devices can view the same chat; events fan out to all.
- Agents run fully auto-approved — the container boundary is the safeguard
  (isolated container, single project mount, no host access).

### Read-only mode (dashboard extension)

The dashboard ships a pi extension mounted into every agent container. It
registers the extension command `/read-only on|off`, invoked by the chat UI
via RPC `prompt` — so the toggle is dynamic, mid-session, same container,
same conversation.

Enforcement is in the harness, not in the conversation (same pattern as
Claude Code plan mode, Codex sandbox modes, and opencode permissions):

- **on:** `pi.setActiveTools()` removes `edit`/`write` (keeps `read`, `bash`,
  `grep`, `find`, `ls`); a `tool_call` handler screens bash commands against
  a denylist of mutating patterns (shell redirects, `rm`, `mv`, `sed -i`,
  `tee`, mutating `git` subcommands, etc.) and blocks them with a reason.
- **off:** full toolset restored.
- The model is never told via chat messages to "behave read-only". When it
  attempts a blocked action, the block reason is returned as the tool result
  and it self-corrects — the same mechanism the above harnesses rely on.

Bash screening is a policy layer, not a security boundary. The hard guarantee
is container isolation: an agent can only ever touch its own mounted project
directory.

## Features

### 1. Agents dashboard
The UI groups running agents into sections by project. The notes project has
its own section pinned at the top (see below); other projects follow the same
layout.

For every project section:
- List dashboard-managed agents (`agent.origin=dashboard`): session name,
  model, status, uptime. Terminate (stop + remove).
- Start agent: pick model (defaults from shared pi settings), thinking level,
  and session: new or resume a past conversation (from pi's session dir,
  includes SSH-created ones). New projects are autocreated by jarvis
  (mkdir + git init).

### 2. Notes section (pinned at top)
Notes agents are agents on `/home/dev/notes`, managed through the exact same
UI as every other project — just pinned at the top and one-click to launch,
because this is the everyday ChatGPT replacement:

- One-click "new conversation". Multiple notes conversations at once; each
  shows as a card until closed. Sessions persist, so old conversations can
  be resumed like any other project.
- **Read-only toggle** in the chat UI (default on), per the mechanism above.
- Every notes-agent start does a host-side `git pull` first; failures are
  surfaced (with copy-to-clipboard for handing to an agent).
- Git policy is use-at-your-own-risk: multiple agents may write
  concurrently; no lease, no lock. Agents are instructed (via project
  `AGENTS.md` + a commit/push skill) to stage-commit-push after making
  changes.
- On closing an agent with uncommitted changes: UI warning with
  "close anyway" / "commit & push, then close".
- Quick stage-commit-push skill(s) added to `~/.agents` so agents can be
  told "commit and push" from the phone.

### 3. Chat UI (per agent)
- ChatGPT-style: streaming responses (markdown), composer, stop (abort),
  steer (send while running), collapsible tool-call activity, thinking
  blocks when present.
- Model / thinking-level switching mid-session (RPC `set_model`,
  `set_thinking_level`).

### 4. Notes viewer (Obsidian clone)
- File tree over `/home/dev/notes`, rendered view + raw edit toggle, search.
  Multiple files can be opened and edited in one viewer session.
- On open: host-side `git pull`, errors surfaced with copy-to-clipboard.
- Save button: stages every file edited through the viewer in that session,
  commits, pushes (so dirt from agents isn't swept up).
- Markdown only for now; the future IDE (below) extends this to other types.

## Future improvements

- **IDE mode** — extend the notes viewer to more file formats for looking at
  coding projects.
- **Voice mode** — push-to-talk conversation with the notes agent (speech
  recognition + TTS), interruptible.
- **Image/file attachments** in chat.
- **Delete sessions from the UI.**

## Phases

1. **Core loop** — jarvis `rpc` subcommand (+ git init, host-path mounts,
   UID overrides), dashboard shell-out + Docker attach, chat UI with
   streaming, session persistence + resume.
2. **Notes section** — pinned section UI, read-only toggle extension, git
   pull on start, close-time warning, commit/push skill.
3. **Notes viewer** — Obsidian clone.

## Docs to update after implementation

This README is currently a project spec, not a description of the built
system. After implementation it should be rewritten to describe what exists,
and the other docs need syncing:

- This README — rewrite from spec to actual architecture/usage.
- Root `README.md` — Phase 9 framing and the "Implications for the
  dashboard" section are superseded (agent discovery is now via
  `agent.origin=dashboard`, project autocreate including git init lives in
  jarvis, dashboard shells out to jarvis rather than reimplementing docker
  run flags).
- `agent-images/README.md` and `agent-images/docker-run.md` — jarvis `rpc`
  subcommand, git init in `prepare_workspace()`, host-path workspace mounts,
  sessions mount, `AGENT_UID`/`AGENT_GID` overrides.
