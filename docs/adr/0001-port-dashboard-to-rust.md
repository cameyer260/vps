# Port the dashboard to Rust with a vanilla frontend

The dashboard (server and web UI) is being rewritten in Rust — Axum, Askama
templates, htmx/hyperscript instead of the Hono/React SPA — for
owner-maintainability: fewer abstractions, code that can be read end-to-end,
and full control on the VPS. Conventional ROI math says this port isn't worth
it; it is being done anyway, deliberately — tooling that excites the owner
gets maintained, and that outweighs ecosystem defaults.

## Scope

In: the dashboard server and frontend, then (as the final phase) the pi host
supervisor — same socket protocol, so it swaps independently.

Out (frozen contracts, not rewritten): `dashboard/pi-extension/read-only.ts`
(pi loads TypeScript extensions; it must stay TS), `agent-images/` + `jarvis.sh`
(the jarvis contract), the Python git bridge (stable, security-sensitive —
porting adds risk for zero gain), and the prune tooling.
