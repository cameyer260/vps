#!/usr/bin/env bash
# jarvis — shortcut for the VPS pi agent container (agent-pi).
#
# Usage:
#   jarvis PROJECT [TASK]                interactive; one-shot when TASK is given
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
#
# PROJECT is a bare name resolved under $PROJECTS_DIR (default /home/dev/projects),
# or an absolute path. If the workspace does not exist it is created. jarvis runs
# as dev, so mkdir already makes dev-owned dirs; Docker's plain -v on a missing
# dir would create it as root, which the container's dev user cannot write to.
set -euo pipefail

PROJECTS_DIR="${AGENT_PROJECTS_DIR:-/home/dev/projects}"
AGENTS_DIR=/home/dev/.agents
BX_ENV=/home/dev/.config/bx/bx.env
PI_AUTH=/home/dev/.pi/agent/auth.json

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "jarvis: $*" >&2; exit 1; }

usage() {
  # Prints lines 2..24 of this file (the comment header above) as help text.
  # If you add or remove header comment lines, update the range here to match:
  #   from the parser at the top to the last header line.
  sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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
  echo "$dir"
}

pi_cmd() {
  local dir name image=agent-pi
  [[ $# -ge 1 ]] || die "usage: jarvis PROJECT [TASK]"
  dir="$(prepare_workspace "$1")"
  name="agent-pi-$(basename "$dir")"
  shift
  require_image "$image"

  local args=()
  args+=( --rm \
    --name "$name" \
    --user "$(id -u dev):$(id -g dev)" \
    -v "$dir:/workspace" \
    -v "$AGENTS_DIR:/home/dev/.agents:ro" \
    -w /workspace \
    --env-file "$BX_ENV" )
  if [[ -f "$PI_AUTH" ]]; then
    args+=( -v "$PI_AUTH:/home/dev/.pi/agent/auth.json" )
  else
    echo "jarvis: warning: $PI_AUTH missing — pi login won't persist across runs" >&2
  fi

  if (( $# > 0 )); then
    # One-shot: print the response and exit. Extra stdin is passed through.
    docker run -i "${args[@]}" "$image" pi -p --approve "$@"
  else
    # Interactive TUI; -a trusts project-local files.
    docker run -it "${args[@]}" "$image" pi -a
  fi
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
    build)  "$HERE/build-images.sh" ;;
    help|-h|"") usage 0 ;;
    *) pi_cmd "$cmd" "$@" ;;
  esac
}

main "$@"
