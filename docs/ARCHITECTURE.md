# Architecture

Status: Built. The site runs on this host as the `admin.service` systemd user
unit behind the existing tunnel: the `dashboard/` crate serves the notes browser
(tree, Obsidian-fidelity reading view, live filename search, read-only
attachments), published pages under `/s/<slug>/`, and the vendored assets, and
the two agent skills in `skills/` are registered on the host.

## Overview

One Rust binary (Axum) serving server-rendered HTML with htmx, styled by a
Tailwind stylesheet that is built with the standalone CLI and
committed. There is no database and no client-side framework: the filesystem is
the source of truth, and every page is a full HTML response or an htmx fragment
swapped into it. The systemd user unit that runs the binary on port 3000 behind
the existing Cloudflare tunnel and Access is `admin.service`, registered from
`tools/`.

```
 phone / Mac
      │ HTTPS
      ▼
 Cloudflare edge ──(Access: owner only)──┐
      │                                  │
      │ tunnel (cloudflared, user unit)  │
      ├──────────────────────────────────┤
      │                                  │
      ▼ HTTP localhost:3000              ▼ HTTP localhost:4173
 admin site (systemd user unit)     dev-review server
 reads: /home/dev/notes (ro)        (started on demand by an agent,
        published dir (ro)           stopped when review ends)
```

## Components

- **`dashboard/` crate** — the site. Modules:
  - `main.rs` — the binary: reads configuration, initialises logging, binds
    `0.0.0.0:$PORT`, and shuts down cleanly on SIGINT/SIGTERM.
  - `lib.rs` — the router: `/` (the notes browser), `/search` (the tree filter),
    `/notes/…` and `/download/notes/…` (notes and attachments), `/s/…`
    (published pages), `/health` (200, body `ok`), `/static/…` served from
    the assets directory, and the icon and manifest paths below.
  - `config.rs` — environment configuration: notes root, published root, port,
    log level, assets directory, and a fingerprint of the vendored assets.
    Defaults match this host; a missing notes root logs a warning and still
    boots.
  - `templates/notes.html`, `templates/publish.html` — the two Askama pages: the
    notes browser (sidebar, reading pane, attachment dialog) and the
    published-pages index. The notes page is a full document; `hx-boost`
    navigation keeps it and swaps only the reading pane, so there is no client
    router and no client state. Both carry the empty
    `div.status-bar-backdrop` that keeps the iOS status bar solid in an
    installed app (see "Decisions and why").
  - `assets/` — `css/input.css` plus the committed Tailwind output
    `css/app.css`, the vendored `js/` (htmx and our `app.js`; versions and
    sources in `assets/js/VENDORED.md`), and `icons/` — the app's mark in every
    shape a browser or a phone asks for. All of it carries the fingerprint from
    `config.rs` (`/static/css/app.css?v=…`, `/static/icons/favicon.svg?v=…`), so
    a deploy cannot leave a stale copy in a browser or at Cloudflare's edge.
  - `icons.rs` — `/site.webmanifest`: the web app manifest, built as JSON with
    the vault's name, the app's `#1e1e1e`, `display: standalone` and the two
    fingerprinted icon sizes. It also serves a second, root-path copy of the
    icons (`/favicon.ico`, `/apple-touch-icon.png`, …) from an allow-list with
    an hour's cache, for the clients that never read the HTML.
  - `notes.rs` — hidden-entry-aware notes tree (Obsidian-shaped rows with
    chevrons and guide lines), live filename-only search that replaces just the
    tree's rows, read-only attachment serving with the pre-download dialog's
    data attributes, htmx fragment responses for navigation, inline-size
    fallback and canonical-path confinement.
  - `render.rs` — frontmatter properties, pulldown-cmark GFM, ammonia
    sanitization, relative note links, wikilinks, callouts, `==highlight==`, tags
    and anchor tags written in raw HTML.
  - `publish.rs` — `/s/` index and static serving from `/home/dev/throwaway-pages` (or
    `PUBLISHED_DIR`), with slug validation, MIME types, local-time publish
    stamps, canonical confinement, and the back-arrow navigation injected into
    every HTML document it serves.
- **Cloudflare tunnel and Access** — existing, outside this repo. The tunnel
  routes a hostname to a localhost port and Access gates it to the owner's
  account. Each hostname has to be attached to an Access application — a tunnel
  route on its own is public — but the shared Access team domain means one login
  covers all of them. The dev-review hostname (`dev.christophermeyer.dev`
  → localhost:4173) sits one level under the zone, so Universal SSL covers it,
  and is attached to the same Access application as the admin hostname;
  configured in the Cloudflare dashboard only.
- **`skills/publish-page/`, `skills/review-dev-site/`** — agent-facing skills in
  this repo, symlinked into `~/.agents/skills/` and `~/.claude/skills/`. They are
  documentation-as-code: they tell an agent where pages go, what URL results, and
  how the dev-review port and hostname behave.
- **`tools/admin.service`** — the systemd user unit for the site: the release
  binary from the deploy checkout (`/home/dev/vps/dashboard/target/release/dashboard`),
  with `dashboard/` as its working directory so `ASSETS_DIR` resolves to the
  vendored assets. It pins `PORT=3000` and `LOG_LEVEL=info`, restarts on
  failure, logs to journald, and reads an optional `~/.config/admin/env` (any
  config knob) last. Like the screenshots units it lives in the repo and is
  registered by symlink into `~/.config/systemd/user/`; the README has the
  install and upgrade steps.
- **`tools/prune-screenshots.*`** — independent of the site: a script plus
  systemd user timer that prunes the screenshots inbox. Registered by symlink
  from `~/.config/systemd/user/`; see the README.

## Data flow / key flows

- **Read a note.** Request → decoded path confined to the canonical notes root
  → lossily decoded Markdown or read-only attachment response → frontmatter
  properties → GFM and Obsidian syntax → ammonia sanitization → Askama page;
  htmx swaps the reading pane while keeping the shell. An htmx request gets the
  pane's contents alone, a history restore and a plain load get the whole page,
  and a non-markdown path asked for over htmx answers `HX-Redirect` so the
  browser navigates and the file opens or downloads.
- **Find a note by name.** Debounced keystrokes → case-insensitive substring
  match against relative Markdown paths only → the response is the tree's rows,
  which replace the list in place; no matches show an empty state. Results are
  a flat list sorted case-insensitively by relative path, and the filter box
  keeps its focus and text. Contents are never read and there is no index.
- **Publish a page.** An agent writes files into `/home/dev/throwaway-pages/<slug>` (via
  the skill) → requests to `/s/<slug>/…` resolve under the published root and
  are served with extension-based content types: an HTML document gets the
  back-arrow navigation injected as it is served, everything else is served
  verbatim → `/s/` lists valid page directories by directory mtime, newest
  first.
- **Install the app on a phone.** Add to Home Screen → iOS reads the 180px
  `apple-touch-icon.png` (opaque, full-bleed) and the
  `apple-mobile-web-app-title` meta for the label; Android and Chrome read
  `/site.webmanifest` for the name, the tile colours, `start_url: /` and the
  192/512 icons → launching opens the site with no browser chrome
  (`display: standalone`), and the status-bar strip that needs is the one
  `app.js` marks the document for (see below). No service worker and no
  offline mode: this is an installed window, not a cached app.
- **Review a dev server.** Owner asks → if something already holds port 4173 the
  agent reports it and waits for the owner's call → agent starts the app's dev
  server on port 4173, bound to `127.0.0.1` (only cloudflared connects) over
  plain HTTP → owner opens `dev.christophermeyer.dev`, which the tunnel forwards
  to 4173 → agent stops the server when the review ends. Verified end to end:
  the tunnel forwards the public hostname as the origin `Host`, and a Vite dev
  server serves through it once `server.allowedHosts` includes the hostname
  and its HMR client is pointed at the public origin
  (`server.hmr = { protocol: 'wss', clientPort: 443 }`), which live-updated a
  page on the phone.

## Data model

No database, no migrations, no persistent app state. Two filesystem roots:

- **Notes root** (`/home/dev/notes`) — read-only from the app's perspective. A
  note is a path plus its file contents; the tree is derived by walking it.
  Dotfiles and dot-directories are omitted. All file and directory symlinks are
  canonicalized and confined before traversal or serving; the in-root
  `CLAUDE.md → AGENTS.md` link is allowed.
- **Published root** (`/home/dev/throwaway-pages`, `PUBLISHED_DIR` overrides) — one
  directory per published page, named by a 1–64 character ASCII slug matching
  `[a-z0-9][a-z0-9-]*`; the page's publish time is the directory's mtime.
  Invalid names and non-directory entries are ignored; replacing a slug's
  directory contents replaces what is served, with no versions.

## External dependencies

- **cloudflared + Cloudflare Access** (existing) — the only route in. Limits: no
  API token on the host, so routes and Access hostnames are dashboard changes;
  Cloudflare applies HTTP/2 and its own request limits, and idle-timeout
  behaviour for streams is Cloudflare's, not ours. Verified through the
  dev-review route: cloudflared forwards the public hostname as the origin `Host`
  header, and WebSocket upgrades pass through the tunnel and Access — Vite's HMR
  client held a `wss://` connection and pushed an update live.
- **Tailwind standalone CLI** — already installed on the host; used only when
  styles change, output committed.
- **rustup/cargo** — already installed; the release build happens on the box.
- **Crates** (the `dashboard/` crate's list; each earns its place): axum +
  tokio (the server), tower-http (static assets), askama (templates), serde
  (query-string decoding) + serde_json (the web app manifest), pulldown-cmark +
  ammonia (the markdown pipeline), log + env_logger (journald-friendly
  logging), time (published-page timestamps).
  Deliberately absent: no database crate, no WebSocket crate, no JS framework,
  no markdown WYSIWYG editor, no CSV crate.
- **Vendored frontend assets** — htmx and a small `app.js` of ours, served from
  `dashboard/assets/js/`; versions and sources recorded in
  `assets/js/VENDORED.md`.
- **The icon set** — generated once from the source image the owner supplied
  (`~/screenshots/Minimal Blue Open Book Icon.png`) and committed, like the
  Tailwind output; nothing at build or deploy time reads the source. The README
  has the set and the recipe, and `favicon.svg` is the vector original to work
  from.
- **The notes repo itself** — a git repo synced with GitHub; the app reads it and
  never writes.

## Tech stack

Rust (edition 2024), Axum, Askama templates, htmx, Tailwind CSS,
systemd user service, Cloudflare tunnel + Access. Chosen because the whole system
is small enough to read end to end, deploys as a single binary with nothing to
run it (no Node runtime, no container), and the owner maintains it directly.

## Decisions and why

- **Dev-review hostname one level under the zone (`dev.christophermeyer.dev`).**
  The deeper-looking name, `dev.admin.christophermeyer.dev`, is a multi-level
  subdomain, and Cloudflare's Universal SSL certificate
  (`*.christophermeyer.dev`) only covers one level — serving it would have
  needed an Advanced Certificate. One level down is covered by the existing
  certificate and still shares the zone's single Access application.

- **Native systemd user service, not a container.** A compiled binary needs no
  runtime packaging; the host already runs user units, and containers here only
  ever existed to ship a Node app. The unit lives in the repo
  (`tools/admin.service`) and is registered by symlink, so a deploy is `git
  pull` in the deploy checkout, `cargo build --release`, and `systemctl --user
  restart admin` — nothing hand-edited on the host, no runtime installed.
- **htmx + server-rendered HTML, no client framework.** Fewer moving parts, no
  client state machine, works on a phone, and nothing has to be rebuilt
  client-side. htmx 4 requires the `:inherited` suffix for attribute
  inheritance, so the boosted navigation is declared on the body as
  `hx-boost:inherited` + `hx-target:inherited`, and the links that must not be
  swapped (published pages, attachments, downloads) opt out with
  `hx-boost="false"`. Navigation answers with the reading pane alone; a
  history restore asks for the page and gets it whole. htmx 4 reports the
  swapped element on the request context (`detail.ctx.target`), not on
  `event.target`, which is the element that started the request — the phone
  sidebar close and the pane's scroll reset key off that context.
- **The tree copies Obsidian's file explorer.** Top-level rows are flush with
  the folder chevrons, children hang off a vertical guide line dropped from the
  chevron, and only the chevron changes on open — the look the owner already
  reads in, with the extension kept so a row still says what it is. Undo by
  changing the tree markup in `notes.rs` and the `.tree-*` rules in
  `input.css`.
- **The tree expands the chain down to the open note, and the highlight alone is
  not enough.** A link inside a note can point anywhere in the vault, so without
  the expansion the active row is highlighted deep inside collapsed folders and
  the tree says nothing about where the reader is. Two halves do it: a whole-page
  render (first load, refresh, htmx history restore) asks the server, where
  `tree_level` emits `open` on every folder that prefixes the active path; an
  in-page navigation swaps only the reading pane, so the tree is not re-rendered
  at all and `app.js` opens the row's ancestors from the DOM on the same
  `htmx:after:swap` / history event that moves the highlight. Only that chain is
  touched, so folders opened by hand stay open (the reader's open/closed state
  exists only in the DOM — which is why the alternative, answering a note
  navigation with an out-of-band re-render of `#tree-list`, was rejected: it
  would collapse everything the reader had opened and ship the whole row markup
  on every click). The filter box is deliberately left alone: while a query is
  active the rows are a flat result list with no folders to open, and clearing
  the query under the reader would be a worse surprise than the highlight being
  absent from a filtered list. Undo by dropping `reveal()` from `app.js` and the
  `open` test in `tree_level`.
- **The filter is live and replaces only the tree's rows.** A short debounce
  (`input changed delay:250ms`) keeps a keystroke from firing a request per
  character, the swapped region excludes the filter box so focus and text
  survive, and the reading pane is left alone — a search narrows the tree, it
  does not open a results page. Undo by removing the `hx-*` attributes in
  `tree()` and pointing the form at a results route again.
- **A dialog stands between an attachment and its download.** Non-markdown
  files are not notes; clicking one that would download asks first, in a native
  `<dialog>` (centred, Escape and backdrop close, five-second timeout) whose
  button points at the download route. `margin: auto` is set explicitly:
  Tailwind's preflight zeroes the UA margin that centres a modal. PDFs and
  raster images keep opening inline — their rows carry `data-inline`, and the
  route's disposition allowlist is the same list the markup comes from, so
  dialog and route cannot disagree. Without JavaScript the row's own `href`
  still downloads.
- **Tailwind output committed, no CSS build on deploy.** The CLI runs only when
  styles change.
- **The icon set is generated once and committed, and served like any other
  asset — fingerprinted, with root-path fallbacks.**
  The mark is the owner's blue open book on the app's own `#1e1e1e` tile, at the
  sizes each client wants: `favicon.svg` (the modern favicon), `favicon.ico`
  (16/32/48 PNGs in an ICO container), `favicon-16x16.png` and
  `favicon-32x32.png` (the sizes a browser may prefer as PNG),
  `apple-touch-icon.png` (180px, opaque — iOS composites transparency onto
  black, and it never reads the manifest), and `icon-192.png` /
  `icon-512.png` (the installed app's tile, declared `any maskable` because the
  mark sits inside the 80% safe circle, so one file per size serves both the
  masked and the unmasked case).

  The URLs the pages and the manifest declare are
  `/static/icons/<file>?v=<fingerprint>`, so the files are cached for a year and
  re-fetched only when one of them actually changes. That is worth more here
  than it is for a stylesheet: an *unchanged* `apple-touch-icon` URL is exactly
  what iOS keeps serving from its own cache, so a stable URL is how a replaced
  icon fails to appear on a home screen, and a versioned one is the standard
  cure.

  The same files also answer at the site root (`/favicon.ico`,
  `/apple-touch-icon.png`, …), cached for an hour, for the clients that never
  read the HTML: iOS falls back to probing those paths when a page declares no
  icon, and a browser, a link preview or a bookmark tile that is given no icon
  asks for `/favicon.ico`. Both copies are cheap — seven small files and one
  handler — and the fallback is what keeps a future head that loses a link from
  ending up with no icon at all. Undo by dropping `icons::routes` and serving
  the set from `/static` alone.

  `favicon.svg` is a trace of the source raster, not the source itself: the
  source is an AI-generated image whose silhouette is not perfectly smooth, so
  the outline was blurred and re-traced down to 19 nodes (a 243-node trace of
  the raw edge measured no better against the master), and the fill is the
  source's own measured vertical gradient — five stops, `#5bc3fc` at the top of
  the pages to `#016bfc` at the tip. The PNGs are the more faithful rasters: they
  also carry the subtle horizontal shading where the pages curl away from the
  light. The README has the recipe and the source of each file; nothing here is
  generated at build time.
- **The web app manifest is built, not a file.** It carries the vault's name —
  `notes — admin`, with `notes` under the home-screen icon — which comes from
  the notes root at runtime, so a checked-in JSON file would go stale the moment
  the vault directory is renamed. It is written with `serde_json` rather than
  formatted by hand, because the vault's name is a filesystem name and a quote
  in it must not be able to break the document a browser has to parse (a test
  serves one with a quote and a backslash in it). `display: standalone` is what
  makes an installed app open without browser chrome; the two
  `apple-mobile-web-app-*` metas in the templates cover iOS, which has read a
  manifest of its own only since 16.4. There is deliberately no service worker:
  the app is live notes, not something to cache offline.
- **No database.** Notes and published pages are files; anything else is derived.
- **Notes are read-only in v1.** Editing is the part that grows (autosave,
  drafts, conflicts, git interaction); leaving it out keeps this version small
  and safe, and it can be added without changing the shape of the app.
- **Static publishing is a directory served at `/s/<slug>/`, not an upload API.**
  The root is `/home/dev/throwaway-pages` — named so it never reads as
  production hosting. Throwaway artifacts stay out of git, there is no registry
  to maintain, and an agent can publish with a file write. Slugs are 1–64
  lowercase ASCII letters, digits and hyphens, starting with a letter or digit;
  invalid root entries are ignored and replacing a slug's directory replaces
  what is served, with no versions.
- **Published content uses extension-based MIME types, and `/s/` is a compact
  list in the site's own dress.** HTML and script bytes pass through unchanged so
  visuals execute as authored; known web/image/document extensions get browser
  types and unknown types are downloads. The index shows linked slug names in
  newest-first order, styled by the shared stylesheet and carrying a boxed link
  back to the notes site, and renders each publish time in the reader's own
  timezone (the markup keeps the UTC instant and spells it out for readers
  without JavaScript) — no preview/sanitization layer, and the only thing the
  app adds to a published document is the back arrow, below. Undo by changing
  the MIME mapping or the index template.
- **The back arrow on a published page is injected at serve time, not written
  into the page.** A page is written by an agent or by hand and brings its own
  design, with no shared template, so a snippet in the publishing skill would
  reach only future pages and could be forgotten or duplicated; serving is the
  one place every page passes through, so a page published months ago gets the
  navigation the moment the new binary is deployed. Only documents are touched
  — a doctype or an `<html>`, `<head>` or `<body>` tag — so fragments, scripts,
  stylesheets and images stay byte-for-byte, and non-UTF-8 HTML is left alone
  (the app already declares its HTML UTF-8). The markup goes immediately after
  `<body>`, so the fixed-position button has no ancestor between it and the
  body: `transform`, `filter` or `contain: paint` on an ancestor would make
  `fixed` measure against that ancestor instead of the viewport. A document
  with no body tag — the `<!doctype html><main>…` shape — gets it before
  `</html>` instead, the same top level of the implied body. The button is
  self-contained (its own small `<style>`, the site's theme variables with the
  site's values as fallbacks) because linking `app.css` would drag Tailwind's
  preflight into arbitrary page designs; it copies the notes page's sidebar
  toggle so the two read as the same chrome, with a back arrow in place of the
  file-tree glyph. There is no duplicate check and no per-page opt-out: every
  document served gets exactly one arrow. Rejected: an HTML-rewriting parser
  crate (`lol_html`) that would rewrite documents we do not own for a ~1 KB
  insertion. Undo by removing the injection from `publish.rs`.
- **One fixed dev-review port (4173) instead of on-demand tunnels or
  subdomains.** No Cloudflare credentials are needed on the host, there is
  nothing to set up per use, and one at a time is acceptable. The cost is the
  stale-server check in the skill: an occupied port stops the start until the
  owner decides whether to kill the listener or leave it.
- **Obsidian fidelity by copying its documented CSS variables** (palette, text
  tiers, accent, font stacks, 16px text, heading scale, 700px readable column)
  rather than inventing a design. It is a look the owner already reads in, so it
  removes design guesswork and gives a concrete acceptance bar.
- **Sanitized markdown.** Markdown-generated elements survive, as do note
  anchors, task-list checkboxes and code classes; scripts, event-handler
  attributes, `javascript:` URLs, `style` and other raw HTML are stripped.
- **Attachments open inline only for PDF and common raster image formats.**
  This lets phone users read them without a separate download flow; other files
  are downloads and files over 1 MiB always get an explicit download fallback.
  Undo by changing the allowlist in `notes.rs` to force attachment disposition.
- **Search results sort by case-insensitive relative path and replace the tree's
  rows.** Stable ordering makes repeated searches predictable; no note content
  is read. Undo by changing the comparator and query presentation in `notes.rs`.
- **Vendored assets, no CDN.** Offline-safe, no third-party fetches, no
  supply-chain surprises at runtime. Only htmx is vendored: the SSE extension
  and hyperscript were never used (the mobile toggle is three lines of
  `app.js`), so they were dropped rather than carried.
- **Assets are fingerprinted and immutable-cached.** `app.css`, `app.js` and
  `htmx.min.js` are requested as `/static/…?v=<fingerprint of the assets
  directory>` and served with `Cache-Control: public, max-age=31536000,
  immutable`; the HTML itself is never cached. The first deploy without this
  proved the need: the new HTML arrived with the previous stylesheet and script
  from Cloudflare's edge, which looked exactly like unimplemented work on the
  owner's phone. Undo by dropping `Config::asset_version` and the middleware in
  `lib.rs` — at the cost of manual cache purges after every deploy.
- **A fixed 8px strip gives the iOS status bar a solid colour.** Since iOS 26
  the installed (home-screen) app renders fullscreen, and iOS 27 draws a system
  blur over its top strip — a faint band over even a flat background, and it
  washes over content near the top. `theme-color` and
  `apple-mobile-web-app-status-bar-style` are ignored, and a `background-color`
  on `body` colours the bar but leaves the blur below it. The one thing that
  works: a `position: fixed` element within 4px of the top, at least ~6px tall
  and 80% of the screen wide, with a background colour — the bar then takes that
  colour with no blur. `.status-bar-backdrop` in both templates is that element,
  painted `--background-primary`, so the bar goes solid `#1e1e1e` and the app
  looks the same. It renders only in an installed app on a touch device
  (`@media (display-mode: standalone) and (hover: none) and (pointer: coarse)`,
  with `html.is-standalone` set by `app.js` from `navigator.standalone` as a
  second trigger, since iOS has reported the display mode inconsistently), so a
  browser render is untouched — including the desktop-installed case, where
  the strip would otherwise paint over the sidebar's top edge. Undo by deleting
  the element and the `.status-bar-backdrop` rules, at the cost of the blur.
  Revisit when Apple changes this again; it has changed twice in two releases.
- **The status-bar strip is reserved space, not an overlay.** The layout starts
  below the status bar, so an element at `position: fixed; top: 0` sits at the
  top of the *reading pane*, not under the bar — overlaid, an 8px strip clips
  the pane's first row (the boxed link's top border) and paints a lighter band
  across the top of the phone sidebar, which is exactly what the first version
  did. So one custom property drives the whole thing: `--status-bar-strip` is
  `0px` by default and `8px` in the installed contexts. `body` pads by it,
  `.app-shell` subtracts it from its height (`calc(100dvh - var(--status-bar-strip))`,
  so the page still never scrolls), `.sidebar-toggle` offsets by it (it is fixed
  to the viewport), and the strip is only as tall as it. `.app-shell` is
  `position: relative` so the phone's sidebar overlay anchors to the shell and
  starts below the strip too; the shell covers the viewport exactly, so that
  changes nothing in a browser. Net effect in an installed app: everything moves
  down 8px, the strip covers empty background, and no content is clipped.
- **No ADR files.** Decisions and their reasons live here.

## Invariants & constraints

- The app never writes to the notes repo, and there are no write endpoints in
  this version.
- Note contents are read only to render the note being viewed: nothing scans or
  indexes them, so there is no content search.
- Every served path is resolved within its configured root; traversal and
  symlink escapes are rejected (the notes repo contains an internal symlink,
  `CLAUDE.md → AGENTS.md`).
- Published pages are served exactly as written (they may contain scripts) and
  must stay inside the Access boundary.
- Both local origins are plain HTTP; TLS terminates at Cloudflare.
- Every tunnel hostname is Access-gated; a route without Access is a
  misconfiguration, not a convenience.
- No secrets in the repo; host credentials stay on the host.
- Assets are vendored; nothing is fetched from a CDN at runtime.
- Host registrations must keep working: the site and screenshots units symlink
  out of `~/vps/tools/`, and the skills symlink out of `~/vps/skills/`.
