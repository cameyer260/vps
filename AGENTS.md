# AGENTS.md

Context and invariants for any AI working in this repo. The dashboard in
particular is designed around the VPS setup described here — read this before
making changes. Deeper reference: [docs/vps.md](docs/vps.md) (host
environment).

## VPS

- Hostinger VPS, Ubuntu 24.04.4 LTS, 2 AMD EPYC vCPUs, ~8 GB RAM, 100 GB disk.
- All routine work runs as the unprivileged `dev` user; `root` is only for
  host-level administration. Everything here must run as `dev` too.
- Network access is locked down: the Hostinger firewall drops all inbound
  public traffic, and UFW only permits SSH over the `tailscale0` interface.
  The only way the dashboard is reachable from the internet is via a
  Cloudflare tunnel to localhost.
- Docker Engine + Compose plugin are installed; `dev` is in the `docker`
  group (no sudo needed). systemd lingering is enabled for `dev`, so any
  long-running process should be a systemd user service or a container.
- Credentials live on the host and are mounted in at runtime — never baked
  into images (table in [docs/vps.md](docs/vps.md)).
- The notes project lives at `/home/dev/notes` (a git repo synced with
  GitHub). It is the default/always-on agent's workspace.

## Validating dashboard work

Dashboard changes must never be shipped untested: drive them through the
mock harness — `MOCK_SCENARIO=… npm run dev:mock` + `npm run dev:web`, the
scenario matching the work, and `node scripts/mock-smoke.mjs` green plus
`npm run typecheck && npm run build` before committing. Full loop, scenario
table, and per-fix definition of done:
[dashboard/docs/testing.md](dashboard/docs/testing.md).

## How the docs are organized

- `README.md` files — orientation and operations (what it is, how to
  run/build/deploy).
- `AGENTS.md` (this file) — invariants for AI agents.
- `docs/` — technical reference (VPS environment).
- `dashboard/ARCHITECTURE.md` — dashboard internals (bridge, events socket,
  read-only mode, roadmap).
- Each fact is documented in exactly one place; link instead of duplicating.