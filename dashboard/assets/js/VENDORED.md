# Vendored frontend assets

These files are served by the app itself from `/static/js/` — no CDN and no
`npm`, at build time or runtime. Update one by re-downloading the exact file
below and committing the result.

| File | Version | Source |
|---|---|---|
| `htmx.min.js` | htmx 4.0.0 | `https://cdn.jsdelivr.net/npm/htmx.org@4.0.0/dist/htmx.min.js` |

`app.js` is ours — small shell glue, nothing to track a version of.

Notes:

- htmx is browser JavaScript; there is no Linux build. "Download a copy" means
  saving `htmx.min.js` into this directory (done above).
- htmx 4 namespaces its events: it is `htmx:after:swap`, not `htmx:afterSwap`
  (see `app.js`).
- **htmx 4 inheritance is explicit.** Attribute inheritance needs the
  `:inherited` suffix (`hx-boost:inherited`, `hx-target:inherited`); a plain
  `<body hx-boost="true" hx-target="#reading-pane">` boosts nothing and every
  link becomes a full page load. `templates/notes.html` carries the suffixed
  form, and an element's own plain attribute still wins, which is how the box
  and attachment links opt out with `hx-boost="false"`.
- `hx-trigger` modifiers (`input changed delay:250ms`) are unchanged from
  htmx 2 and drive the live tree filter.
