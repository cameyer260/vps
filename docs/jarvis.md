# jarvis — the agent container contract

`jarvis` is a bash wrapper (`agent-images/jarvis.sh`, symlinked onto the VPS
PATH at `~/bin/jarvis`) around a `docker run` statement that launches **pi**
(the `@earendil-works/pi-coding-agent` CLI) inside a container built from the
`agent-pi` image (see [agent-images/README.md](../agent-images/README.md)).

**This file is the single source of truth for jarvis's behavior.** The
dashboard shells out to it and never re-derives the flags; the canonical
`docker run` statements jarvis invokes are in
[`agent-images/docker-run.md`](../agent-images/docker-run.md).

## Modes

```bash
jarvis PROJECT [TASK]
```

- No TASK: interactive pi TUI (`docker run -it ... pi -a`).
- With TASK: one-shot mode (`docker run -i ... pi -p --approve "$@"`), prints
  the response and exits. Extra args (e.g. `--provider`, `--model`) are
  forwarded to pi as-is.

```bash
jarvis rpc PROJECT [pi args...]
```

Detached `pi --mode rpc` daemon for the dashboard (`docker run -d -i`, never
`-t`: stdin stays open so the dashboard can attach and send prompts later; a
TTY corrupts pi's LF-framed JSONL protocol). Adds:

- label `agent.origin=dashboard` (what the dashboard filters on)
- the dashboard's read-only extension via `pi -e`, mounted read-only from
  `dashboard/pi-extension/read-only.ts`; `PI_DASHBOARD_READONLY=1` is passed
  into the container when set in the caller's environment
- prints the container ID on stdout

```bash
jarvis projects     # list host projects
jarvis build        # rebuild the images
```

## PROJECT resolution & workspace prep

PROJECT is a bare name resolved under `/home/dev/projects` (override with
`AGENT_PROJECTS_DIR`) or an absolute path. Missing workspaces are
pre-created by `prepare_workspace()` with `mkdir` **plus `git init`** as
`dev` — jarvis runs as `dev`, so the dirs are dev-owned (plain Docker `-v`
on a missing dir would create them root-owned, which breaks the container's
dev user). Workspace autocreate happens exactly once, for CLI and
dashboard-launched agents alike.

## Container run flags

- `--rm`, `--user "${AGENT_UID:-$(id -u dev)}:${AGENT_GID:-$(id -g dev)}"` —
  unset (normal SSH use) does the `id` lookup; the dashboard container,
  which has no `dev` user of its own, is deployed with `AGENT_UID`/
  `AGENT_GID` set and they are inherited by every jarvis invocation.
- `-v <project>:<project>` — workspace mounted at its **real host path**,
  workdir there (not `/workspace`), so sessions group with host pi runs.
- `-v /home/dev/.pi/agent/sessions:/home/dev/.pi/agent/sessions` (rw;
  override with `PI_SESSIONS_DIR`) — sessions survive `--rm` and are shared
  across dashboard and SSH/TUI runs, so resuming works from both worlds.
- `-v /home/dev/screenshots:/home/dev/screenshots:ro` (override with
  `SCREENSHOTS_DIR`) — screenshots inbox (scp target for the Mac screenshot
  tool), mounted at the same host path so a pasted host path reads verbatim
  inside the container. Read-only so agents can view screenshots but never
  write/delete them; pruning happens on the host via the systemd timer (see
  docs/vps.md).
- `-v /home/dev/.agents:/home/dev/.agents:ro` — agent skills.
- `-v /home/dev/.pi/agent/auth.json:/home/dev/.pi/agent/auth.json` — pi auth
  (mounted rw so refreshed sessions persist on the host; added only when the
  host file exists, with a warning otherwise).
- `-v /home/dev/.pi/agent/settings.json:/home/dev/.pi/agent/settings.json:ro`
  — shared defaults: provider/model/thinking level; read-only so agents
  can't rewrite host settings.
- `--env-file /home/dev/.config/bx/bx.env` — Brave Search API key.
- `--append-system-prompt "$AGENT_CONTEXT"` (all modes) — a short
  environment-context paragraph appended to pi's system prompt: the agent is
  told it runs in an ephemeral container, that the workspace is its task area
  and only output location, and to report back rather than leave the
  workspace. Defined inline in `jarvis.sh` (`AGENT_CONTEXT`); deliberately
  factual so agents can verify each claim (sessions, for instance, do persist
  outside the workspace — pi writes them there).
- Labels: `agent.kind=pi`, `agent.project=<project-basename>`. **No
  `--name`** — multiple agents can run on one project concurrently;
  discover agents via labels, never container names.
- Models are accessed through the OpenRouter provider.