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
[[ -f "$HOME/.gitconfig" ]] || { echo "deploy: $HOME/.gitconfig missing (git identity for commits)" >&2; exit 1; }

DOCKER_GID="$(getent group docker | cut -d: -f3)"
[[ -n "$DOCKER_GID" ]] || { echo "deploy: docker group not found" >&2; exit 1; }

echo "==> building image"
docker build -t dashboard .

docker rm -f "$NAME" >/dev/null 2>&1 || true

# Mount ~/.ssh read-only when present so HTTPS/SSH git remotes keep working.
SSH_MOUNT=()
if [[ -d "$HOME/.ssh" ]]; then
  SSH_MOUNT=(-v "$HOME/.ssh:/home/dev/.ssh:ro")
fi

echo "==> running on 127.0.0.1:$HOST_PORT (tunnel target)"
exec docker run -d --name "$NAME" \
  --user "$(id -u):$(id -g)" \
  --group-add "$DOCKER_GID" \
  -e AGENT_UID="$(id -u)" \
  -e AGENT_GID="$(id -g)" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$REPO:/home/dev/vps:ro" \
  -v /home/dev/projects:/home/dev/projects \
  -v /home/dev/notes:/home/dev/notes \
  -v /home/dev/.pi/agent/sessions:/home/dev/.pi/agent/sessions \
  -v "$HOME/.gitconfig:/home/dev/.gitconfig:ro" \
  "${SSH_MOUNT[@]+"${SSH_MOUNT[@]}"}" \
  -p "127.0.0.1:${HOST_PORT}:3000" \
  dashboard
