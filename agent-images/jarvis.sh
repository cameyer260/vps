#!/usr/bin/env bash
# jarvis — shortcut for the VPS pi agent container (agent-pi).
#
# Usage:
#   jarvis PROJECT [TASK]                    interactive; one-shot when TASK is given
#   jarvis rpc PROJECT [pi args...]          headless pi RPC daemon (for the dashboard)
#   jarvis projects                          list host projects
#   jarvis build                             rebuild all images
#   jarvis help
#
# Modes:
#   one-shot (headless)  jarvis PROJECT TASK [--provider P] [--model M]
#     Prints the response and exits; extra stdin is passed through.
#     All args after PROJECT are forwarded to pi as-is, so pi provider/
#     model flags work here:
#       jarvis proj --provider openai --model gpt-4o "write tests"
#       jarvis proj --model anthropic/claude-sonnet-4-5 "refactor this"
#   interactive           jarvis PROJECT
#     Opens the pi TUI. Switch provider/model at runtime with /model
#     or Ctrl+L; project-local config is trusted via -a.
#   rpc                   jarvis rpc PROJECT [pi args...]
#     Starts a detached, long-lived pi RPC daemon (JSONL over stdin/stdout)
#     for the dashboard to attach to. Prints the container ID on stdout.
#     - -d -i, never -t: stdin must stay open so the dashboard can send
#       prompts later; a TTY corrupts pi's LF-framed JSONL protocol.
#     - Main process is `pi --mode rpc` with -a (trust project-local files).
#     - Loads the dashboard's read-only extension via `pi -e <path>` when it
#       exists in the repo; env PI_DASHBOARD_READONLY=1 is passed into the
#       container when set, so the extension can start read-only.
#     - Extra label agent.origin=dashboard (what the dashboard filters on).
#     - Extra pi args are forwarded as-is (--session, -n, --provider, ...).
#
# PROJECT is a bare name resolved under $PROJECTS_DIR (default /home/dev/projects),
# or an absolute path. If the workspace does not exist it is created (mkdir +
# git init when there is no .git yet). jarvis runs as dev, so mkdir already
# makes dev-owned dirs; Docker's plain -v on a missing dir would create it as
# root, which the container's dev user cannot write to.
#
# Workspaces are mounted at their real host path (/home/dev/projects/foo,
# workdir there) and /home/dev/.pi/agent/sessions is mounted rw at the same
# path, so container sessions group under the same project as host pi sessions
# and resume works across dashboard and SSH/TUI runs.
#
# The dev UID/GID for `--user` resolves as ${AGENT_UID:-$(id -u dev)}: unset
# (normal SSH use) means an id lookup, exactly as before. The dashboard
# container (where no dev user exists) is deployed with AGENT_UID/AGENT_GID
# set, and they are inherited by every jarvis invocation it makes.
set -euo pipefail

PROJECTS_DIR="${AGENT_PROJECTS_DIR:-/home/dev/projects}"
AGENTS_DIR=/home/dev/.agents
BX_ENV=/home/dev/.config/bx/bx.env
PI_AUTH=/home/dev/.pi/agent/auth.json
PI_SETTINGS=/home/dev/.pi/agent/settings.json
SESSIONS_DIR="${PI_SESSIONS_DIR:-/home/dev/.pi/agent/sessions}"

HERE="$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")" && pwd)"
# Monorepo root (repo is cloned to /home/dev/vps on the VPS). Used to locate
# the dashboard's pi extension, which gets mounted read-only into rpc agents.
REPO_ROOT="$(cd "$HERE/.." && pwd)"

die() { echo "jarvis: $*" >&2; exit 1; }

usage() {
  # Prints the comment header above as help text.
  # If you add or remove header comment lines, update the range here to match:
  #   from the line after shebang to the last header line.
  sed -n '2,44p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

require_image() {
  local image="$1"
  docker image inspect "$image" >/dev/null 2>&1 ||
    die "image '$image' not found — run 'jarvis build' first"
}

resolve_project() {
  case "$1" in
    /*) echo "$1" ;;
    *)  echo "$PROJECTS_DIR/$1" ;;
  esac
}

prepare_workspace() {
  local dir
  dir="$(resolve_project "$1")"
  if [[ ! -e "$dir" ]]; then
    if [[ "$dir" == "$PROJECTS_DIR"* ]]; then
      mkdir -p "$PROJECTS_DIR"
    fi
    echo "jarvis: workspace '$dir' does not exist — creating it" >&2
    mkdir -p "$dir"
  fi
  [[ -d "$dir" ]] || die "workspace '$dir' exists but is not a directory"
  # Autocreate the git repo (once). Dashboard agents rely on it existing.
  if [[ ! -e "$dir/.git" ]]; then
    if git -C "$dir" init -q 2>/dev/null; then
      echo "jarvis: initialized git repo in '$dir'" >&2
    else
      echo "jarvis: warning: git init failed in '$dir'" >&2
    fi
  fi
  echo "$dir"
}

dev_uid() { echo "${AGENT_UID:-$(id -u dev)}"; }
dev_gid() { echo "${AGENT_GID:-$(id -g dev)}"; }

# Flags shared by every mode, stored in the global BASE_ARGS array.
# Call with the resolved workspace dir as $1.
base_args() {
  local dir="$1"
  # Sessions dir must exist on the host before docker sees the bind mount,
  # or it gets created root-owned and the container's dev user can't write.
  mkdir -p "$SESSIONS_DIR"
  BASE_ARGS=( --rm \
    --user "$(dev_uid):$(dev_gid)" \
    # No --name: multiple agents may run on the same project concurrently, so
    # names would collide. Docker auto-generates a unique one; the project is
    # discoverable via the agent.project label (what the dashboard filters on).
    --label agent.kind=pi \
    --label "agent.project=$(basename "$dir")" \
    -v "$dir:$dir" \
    -v "$SESSIONS_DIR:$SESSIONS_DIR" \
    -v "$AGENTS_DIR:/home/dev/.agents:ro" \
    -w "$dir" \
    --env-file "$BX_ENV" )
  if [[ -f "$PI_AUTH" ]]; then
    BASE_ARGS+=( -v "$PI_AUTH:/home/dev/.pi/agent/auth.json" )
  else
    echo "jarvis: warning: $PI_AUTH missing — pi login won't persist across runs" >&2
  fi
  # Read-only shared defaults (provider/model/thinking level). Without this the
  # container falls back to pi's factory defaults; ro so container-side /model
  # saves can't rewrite the host's settings.
  if [[ -f "$PI_SETTINGS" ]]; then
    BASE_ARGS+=( -v "$PI_SETTINGS:/home/dev/.pi/agent/settings.json:ro" )
  else
    echo "jarvis: warning: $PI_SETTINGS missing — container uses pi factory defaults" >&2
  fi
}

pi_cmd() {
  local dir image=agent-pi
  [[ $# -ge 1 ]] || die "usage: jarvis PROJECT [TASK]"
  dir="$(prepare_workspace "$1")"
  shift
  require_image "$image"

  base_args "$dir"

  if (( $# > 0 )); then
    # One-shot: print the response and exit. Extra stdin is passed through.
    docker run -i "${BASE_ARGS[@]}" "$image" pi -p --approve "$@"
  else
    # Interactive TUI; -a trusts project-local files.
    docker run -it "${BASE_ARGS[@]}" "$image" pi -a
  fi
}

rpc_cmd() {
  local dir image=agent-pi
  [[ $# -ge 1 ]] || die "usage: jarvis rpc PROJECT [pi args...]"
  dir="$(prepare_workspace "$1")"
  shift
  require_image "$image"

  base_args "$dir"
  BASE_ARGS+=( --label agent.origin=dashboard )

  local ext_host="$REPO_ROOT/dashboard/pi-extension/read-only.ts"
  local ext_mount=() ext_flags=()
  if [[ -f "$ext_host" ]]; then
    ext_mount=( -v "$ext_host:/home/dev/.pi/agent/dashboard-readonly.ts:ro" )
    ext_flags=( -e /home/dev/.pi/agent/dashboard-readonly.ts )
  else
    echo "jarvis: warning: dashboard read-only extension missing ($ext_host) — starting without it" >&2
  fi

  local ro_env=()
  if [[ -n "${PI_DASHBOARD_READONLY:-}" ]]; then
    ro_env=( -e "PI_DASHBOARD_READONLY=${PI_DASHBOARD_READONLY}" )
  fi

  # -d -i, never -t: the dashboard attaches later and writes LF-framed JSONL
  # to stdin; a TTY would mangle it. Prints the container ID on stdout.
  # (${arr[@]+"${arr[@]}"} keeps empty arrays safe under set -u on old bash.)
  docker run -d -i "${BASE_ARGS[@]}" \
    ${ext_mount[@]+"${ext_mount[@]}"} \
    ${ro_env[@]+"${ro_env[@]}"} \
    "$image" pi --mode rpc -a ${ext_flags[@]+"${ext_flags[@]}"} "$@"
}

list_projects() {
  if [[ -d "$PROJECTS_DIR" ]]; then
    ls -1 "$PROJECTS_DIR"
  else
    echo "jarvis: $PROJECTS_DIR does not exist yet" >&2
    return 1
  fi
}

main() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in
    projects) list_projects ;;
    rpc)      rpc_cmd "$@" ;;
    build)  "$HERE/build-images.sh" ;;
    help|-h|"") usage 0 ;;
    *) pi_cmd "$cmd" "$@" ;;
  esac
}

main "$@"
