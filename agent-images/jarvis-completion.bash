# Optional bash tab-completion for the `jarvis` command.
# Source it from your shell rc, e.g.:
#   echo 'source /home/dev/agent-images/jarvis-completion.bash' >> ~/.bashrc

_jarvis() {
  local cur
  cur="${COMP_WORDS[COMP_CWORD]}"
  if (( COMP_CWORD == 1 )); then
    # Position 1: a project name (the default: runs the pi agent), or the
    # literal subcommands projects/build/help. Resolve the projects dir the
    # same way jarvis.sh does: AGENT_PROJECTS_DIR env var, else the default.
    local projects_dir="${AGENT_PROJECTS_DIR:-/home/dev/projects}"
    COMPREPLY=( $(compgen -W "$(ls "$projects_dir" 2>/dev/null) build help projects" -- "$cur") )
  fi
}
complete -F _jarvis jarvis
