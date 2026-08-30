# docker run

Replace `project-name` and `TASK`. Do not mount `/home/dev` wholesale or the Docker socket.

`/workspace` is the container path; bind one host project onto it (for notes: `/home/dev/notes:/workspace`).

## Pi — interactive

Drop into the TUI. `-a` / `--approve` trusts project-local files.

```bash
docker run --rm -it \
  --name pi-project-name \
  --user "$(id -u dev):$(id -g dev)" \
  --env-file /home/dev/.config/bx/bx.env \
  -v /home/dev/projects/project-name:/workspace \
  -v /home/dev/.agents:/home/dev/.agents:ro \
  -v /home/dev/.pi/agent/auth.json:/home/dev/.pi/agent/auth.json \
  -w /workspace \
  agent-pi pi -a
```

## Pi — one-shot prompt

Print the response and exit. Extra args can be piped in on stdin.

```bash
docker run --rm \
  --name pi-project-one-shot \
  --user "$(id -u dev):$(id -g dev)" \
  --env-file /home/dev/.config/bx/bx.env \
  -v /home/dev/projects/project-name:/workspace \
  -v /home/dev/.agents:/home/dev/.agents:ro \
  -v /home/dev/.pi/agent/auth.json:/home/dev/.pi/agent/auth.json \
  -w /workspace \
  agent-pi pi -p --approve "TASK"
```
