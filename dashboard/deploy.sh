#!/usr/bin/env bash
# Build and run the dashboard container on the VPS (as dev, no sudo).
#
# The dashboard acts as the host dev user (git operations, agent starts via
# jarvis) and reaches the Docker socket, so all identity values are resolved
# here on the host — never hardcoded, never looked up inside the container.
#
# Publishes on 127.0.0.1 only: the dashboard is reachable from the internet
# via a Cloudflare tunnel to localhost (Cloudflare Access handles auth).
#
# The git-bridge socket is mounted at its host path so jarvis's conditional
# bridge mount (docs/jarvis.md) succeeds when jarvis runs inside this
# container — agents get the socket because Docker resolves the bind-mount
# source on the host, but jarvis's -S existence check runs here.
#
# Usage:  ./deploy.sh            (from dashboard/)
#   HOST_PORT=3000   host port the tunnel points at   (default 3000)
#   VPS_REPO=/home/dev/vps  repo clone mount          (jarvis + pi extension)
#   DASHBOARD_NAME=dashboard  container name
set -euo pipefail
cd "$(dirname "$(realpath "$0")")"

NAME="${DASHBOARD_NAME:-dashboard}"
HOST_PORT="${HOST_PORT:-3000}"
REPO="${VPS_REPO:-/home/dev/vps}"

[[ -d "$REPO/agent-images" ]] || {
  echo "deploy: $REPO doesn't look like the vps repo clone (needed for jarvis + the pi extension)" >&2
  exit 1
}
[[ -d /home/dev/projects ]] || { echo "deploy: /home/dev/projects missing" >&2; exit 1; }
[[ -d /home/dev/notes ]] || { echo "deploy: /home/dev/notes missing" >&2; exit 1; }
[[ -d /home/dev/screenshots ]] || { echo "deploy: /home/dev/screenshots missing (mkdir it as dev first — the screenshots inbox the Mac tool scps to)" >&2; exit 1; }
[[ -f "$HOME/.gitconfig" ]] || { echo "deploy: $HOME/.gitconfig missing (git identity for commits)" >&2; exit 1; }
[[ -d "$HOME/.config/gh" ]] || { echo "deploy: $HOME/.config/gh missing (gh CLI auth for git remotes — run 'gh auth login' on the host)" >&2; exit 1; }
[[ -f /home/dev/.config/bx/bx.env ]] || { echo "deploy: /home/dev/.config/bx/bx.env missing (Brave key — jarvis --env-file is fatal without it)" >&2; exit 1; }
[[ -f /home/dev/.pi/agent/auth.json ]] || echo "deploy: warning: /home/dev/.pi/agent/auth.json missing — pi agents will start without login" >&2
[[ -f /home/dev/.pi/agent/settings.json ]] || echo "deploy: warning: /home/dev/.pi/agent/settings.json missing — agents use pi factory defaults" >&2

DOCKER_GID="$(getent group docker | cut -d: -f3)"
[[ -n "$DOCKER_GID" ]] || { echo "deploy: docker group not found" >&2; exit 1; }

echo "==> building image"
docker build -t dashboard .

docker rm -f "$NAME" >/dev/null 2>&1 || true

echo "==> running on 127.0.0.1:$HOST_PORT (tunnel target)"
exec docker run -d --name "$NAME" \
  --restart unless-stopped \
  --user "$(id -u):$(id -g)" \
  --group-add "$DOCKER_GID" \
  -e AGENT_UID="$(id -u)" \
  -e AGENT_GID="$(id -g)" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$REPO:/home/dev/vps:ro" \
  -v /home/dev/projects:/home/dev/projects \
  -v /home/dev/notes:/home/dev/notes \
  -v /home/dev/screenshots:/home/dev/screenshots \
  -v /home/dev/.pi/agent/sessions:/home/dev/.pi/agent/sessions \
  -v /home/dev/.agents:/home/dev/.agents:ro \
  -v /home/dev/.config/bx/bx.env:/home/dev/.config/bx/bx.env:ro \
  -v /home/dev/.pi/agent/auth.json:/home/dev/.pi/agent/auth.json \
  -v /home/dev/.pi/agent/settings.json:/home/dev/.pi/agent/settings.json:ro \
  -v "$HOME/.gitconfig:/home/dev/.gitconfig:ro" \
  -v "$HOME/.config/gh:/home/dev/.config/gh:ro" \
  -v "/run/user/$(id -u)/jarvis-git-bridge.sock:/run/user/$(id -u)/jarvis-git-bridge.sock" \
  -p "127.0.0.1:${HOST_PORT}:3000" \
  dashboard
