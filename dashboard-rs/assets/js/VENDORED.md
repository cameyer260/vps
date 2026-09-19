# Vendored JS

Served locally by the app itself — no CDN, no node (ADR 0005). Update by
re-downloading the exact files below and committing the result.

| File | Version | Source |
|------|---------|--------|
| `htmx.min.js` | htmx 2.0.4 | `https://unpkg.com/htmx.org@2.0.4/dist/htmx.min.js` |
| `sse.js` | htmx-ext-sse 2.2.2 | `https://unpkg.com/htmx-ext-sse@2.2.2/sse.js` |
| `_hyperscript.min.js` | hyperscript 0.9.14 | `https://unpkg.com/hyperscript.org@0.9.14/dist/_hyperscript.min.js` |

`app.js` is ours (viewport glue ported from `dashboard/src/main.tsx`).
