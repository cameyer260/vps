# VPS agent platform

The monorepo for running pi coding agents on a VPS and managing them through
the dashboard. Single context — this glossary is the shared language for all
of it.

## Language

**Agent**:
A pi coding agent instance managed by the dashboard, identified by id, always
launched against a workspace.
_Avoid_: bot, assistant, container (an agent may run bare-metal)

**Runtime**:
How an agent runs — `jarvis` (container, via jarvis) or `host` (bare-metal
pi, via the supervisor). Same word at two zoom levels: the property on an
agent ("its runtime is host"), and the machinery implementing each way (the
runtime seam: Docker / host-supervisor / mock).
_Avoid_: plan mode; the word belongs to this concept only

**Workspace**:
The real directory an agent is launched with — its cwd, usually a git repo.
jarvis pre-creates missing ones.
_Avoid_: repo, folder

**Project**:
The human-facing grouping of agents in the dashboard; the workspace's
basename.
_Avoid_: workspace (that's the directory itself)

**Bridge**:
The server-side link between one agent's pi process and every browser client
viewing its chat: relays traffic, tracks entry state and agent status.
_Avoid_: socket, proxy, ws

**Session**:
A pi conversation log (a `.jsonl` file) that an agent can resume.
_Avoid_: history, chat log

**General Chat**:
An agent started from the General Chat tab, not tied to a project — visible
only there, and terminated automatically after an hour with no viewers.
_Avoid_: GC, casual chat

**Read-only mode**:
A per-conversation agent mode where editing tools are disabled — a policy
layer, not a security boundary.
_Avoid_: plan mode
