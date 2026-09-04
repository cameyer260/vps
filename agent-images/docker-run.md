# docker run

Replace `project-name` and `TASK`. Do not mount `/home/dev` wholesale or the Docker socket.

Workspaces are bind-mounted at their **real host path** (`/home/dev/projects/project-name`,
workdir there — not `/workspace`), so pi sessions group under the same project as host
runs. The host sessions dir (`/home/dev/.pi/agent/sessions`) is mounted rw at the same
path so sessions survive `--rm` and can be resumed from SSH/TUI or the dashboard.
The screenshots inbox (`/home/dev/screenshots`) is mounted read-only at the same
path so a pasted host path reads verbatim inside the container.
Create missing host dirs as `dev` before the run (plain Docker `-v` would create them
root-owned, which the container's dev user can't write to).

jarvis additionally passes `--append-system-prompt "$AGENT_CONTEXT"` to every `pi`
invocation below (environment context + workspace-only policy; text lives in
`jarvis.sh`). Omitted from the statements here for readability.

## Pi — interactive

Drop into the TUI. `-a` / `--approve` trusts project-local files.

```bash
docker run --rm -it \
  --user "$(id -u dev):$(id -g dev)" \
  --label agent.kind=pi \
  --label agent.project=project-name \
  --env-file /home/dev/.config/bx/bx.env \
  -v /home/dev/projects/project-name:/home/dev/projects/project-name \
  -v /home/dev/.pi/agent/sessions:/home/dev/.pi/agent/sessions \
  -v /home/dev/screenshots:/home/dev/screenshots:ro \
  -v /home/dev/.agents:/home/dev/.agents:ro \
  -v /home/dev/.pi/agent/auth.json:/home/dev/.pi/agent/auth.json \
  -v /home/dev/.pi/agent/settings.json:/home/dev/.pi/agent/settings.json:ro \
  -w /home/dev/projects/project-name \
  agent-pi pi -a
```

No `--name`: multiple agents can run on one project concurrently; discover them via the
`agent.project` label.

## Pi — one-shot prompt

Print the response and exit. Extra args can be piped in on stdin.

```bash
docker run --rm -i \
  --user "$(id -u dev):$(id -g dev)" \
  --label agent.kind=pi \
  --label agent.project=project-name \
  --env-file /home/dev/.config/bx/bx.env \
  -v /home/dev/projects/project-name:/home/dev/projects/project-name \
  -v /home/dev/.pi/agent/sessions:/home/dev/.pi/agent/sessions \
  -v /home/dev/screenshots:/home/dev/screenshots:ro \
  -v /home/dev/.agents:/home/dev/.agents:ro \
  -v /home/dev/.pi/agent/auth.json:/home/dev/.pi/agent/auth.json \
  -v /home/dev/.pi/agent/settings.json:/home/dev/.pi/agent/settings.json:ro \
  -w /home/dev/projects/project-name \
  agent-pi pi -p --approve "TASK"
```

## Pi — headless RPC daemon (what `jarvis rpc` runs for the dashboard)

Detached, long-lived `pi --mode rpc` (LF-framed JSONL over stdin/stdout). `-d -i`,
never `-t`: stdin must stay open so the dashboard can attach and send prompts later; a
TTY corrupts the protocol. Labeled `agent.origin=dashboard` (what the dashboard filters
on) and loads the dashboard's read-only extension via `pi -e`. `PI_DASHBOARD_READONLY=1`
is passed in when the caller wants the agent to start read-only.

```bash
docker run --rm -d -i \
  --user "$(id -u dev):$(id -g dev)" \
  --label agent.kind=pi \
  --label agent.project=project-name \
  --label agent.origin=dashboard \
  --env-file /home/dev/.config/bx/bx.env \
  -v /home/dev/projects/project-name:/home/dev/projects/project-name \
  -v /home/dev/.pi/agent/sessions:/home/dev/.pi/agent/sessions \
  -v /home/dev/screenshots:/home/dev/screenshots:ro \
  -v /home/dev/.agents:/home/dev/.agents:ro \
  -v /home/dev/.pi/agent/auth.json:/home/dev/.pi/agent/auth.json \
  -v /home/dev/.pi/agent/settings.json:/home/dev/.pi/agent/settings.json:ro \
  -v /home/dev/vps/dashboard/pi-extension/read-only.ts:/home/dev/.pi/agent/dashboard-readonly.ts:ro \
  -w /home/dev/projects/project-name \
  agent-pi pi --mode rpc -a -e /home/dev/.pi/agent/dashboard-readonly.ts
```

In practice you never type these: `jarvis project-name`, `jarvis project-name "TASK"`
and `jarvis rpc project-name [pi args...]` build them. The dashboard shells out to
`jarvis rpc`.
