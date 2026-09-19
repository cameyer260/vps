# Vendored JS

Served locally by the app itself — no CDN, no node (ADR 0005). Update by
re-downloading the exact files below and committing the result.

| File | Version | Source |
|------|---------|--------|
| `htmx.min.js` | htmx 4.0.0 | `https://cdn.jsdelivr.net/npm/htmx.org@4.0.0/dist/htmx.min.js` ("Download a copy", `https://htmx.org/docs/#installing`) |
| `hx-sse.js` | htmx 4.0.0 bundled extension | `https://cdn.jsdelivr.net/npm/htmx.org@4.0.0/dist/ext/hx-sse.min.js` |
| `_hyperscript.min.js` | hyperscript 0.9.14 | `https://unpkg.com/hyperscript.org@0.9.14/dist/_hyperscript.min.js` |

Notes:

- htmx is browser JavaScript — there is no Linux build. "Download a copy"
  means saving `htmx.min.js` into this directory (done above).
- v4 notes for later phases: extensions register via `registerExtension`
  (`hx-ext="sse"` is unchanged), but the SSE syntax is namespaced now
  (`hx-sse:connect`, `hx-sse:close`; `sse-swap` is removed — unnamed
  messages swap automatically, named events dispatch as DOM events). Old
  `sse-*` attributes still work with deprecation warnings. Phase 3 must
  use the `hx-sse:*` syntax. The standalone `htmx-ext-sse` package
  (2.2.x) is 2.x-API only (`defineExtension`) and is **not** used.
- `hx-boost="true"` is unchanged in v4 (any value but `"false"` enables it).

`app.js` is ours (viewport glue ported from `dashboard/src/main.tsx`).
There is no service worker by decision (see `docs/rust-port.md` Phase 6):
this dashboard is connection-only, so no offline shell is ever useful.
