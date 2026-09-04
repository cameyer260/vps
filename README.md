# vps

Monorepo for everything agent-related on my VPS:

- **`agent-images/`** — Dockerfiles, the `jarvis` wrapper script, and build
  tooling for running pi agents in containers on the VPS.
- **`dashboard/`** — web application for managing those agents (agent
  lifecycle, ChatGPT-like chat UI, Obsidian-like notes viewer).
- **`docs/`** — system documentation: the VPS environment and the jarvis
  contract.

## Documentation map

| You want… | Go to |
|---|---|
| Agent context & invariants for working in this repo | [AGENTS.md](AGENTS.md) |
| VPS environment reference (network, users, credentials) | [docs/vps.md](docs/vps.md) |
| The jarvis contract (how agents run) — single source of truth | [docs/jarvis.md](docs/jarvis.md) |
| Building images, jarvis/symlink setup | [agent-images/README.md](agent-images/README.md) |
| Canonical `docker run` statements | [agent-images/docker-run.md](agent-images/docker-run.md) |
| Dashboard usage & deployment | [dashboard/README.md](dashboard/README.md) |
| Dashboard internals | [dashboard/ARCHITECTURE.md](dashboard/ARCHITECTURE.md) |

The split: READMEs are orientation and operations, `AGENTS.md` holds the
invariants for AI agents, `docs/` and `ARCHITECTURE.md` are the technical
reference. Each fact is documented in exactly one place — link, don't
duplicate.