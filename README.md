# vps

Monorepo for everything agent-related on my VPS:

- **`dashboard/`** — web application for managing agents (agent
  lifecycle, ChatGPT-like chat UI, Obsidian-like notes viewer for a notes
  repo I essentially as a digital notebook containing todos and things like that).
- **`docs/`** — system documentation: the VPS environment.
- **`tools/`** — host-side helpers (screenshots inbox prune script +
  systemd user timer).

## Documentation map

| You want… | Go to |
|---|---|
| Agent context & invariants for working in this repo | [AGENTS.md](AGENTS.md) |
| VPS environment reference (network, users, credentials) | [docs/vps.md](docs/vps.md) |
| Dashboard usage & deployment | [dashboard/README.md](dashboard/README.md) |
| Dashboard internals | [dashboard/ARCHITECTURE.md](dashboard/ARCHITECTURE.md) |
