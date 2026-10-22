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
    (published pages), `/health` (200, body `ok`), and `/static/…` served from
    the assets directory.
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
    `css/app.css`, and the vendored `js/` (htmx and our `app.js`; versions and
    sources in `assets/js/VENDORED.md`). Their URLs carry the fingerprint from
    `config.rs` (`/static/css/app.css?v=…`), so a deploy cannot leave a stale
    copy in a browser or at Cloudflare's edge.
  - `notes.rs` — hidden-entry-aware notes tree (Obsidian-shaped rows with
    chevrons and guide lines), live filename-only search that replaces just the
    tree's rows, read-only attachment serving with the pre-download dialog's
    data attributes, htmx fragment responses for navigation, inline-size
    fallback and canonical-path confinement.
  - `render.rs` — frontmatter properties, pulldown-cmark GFM, ammonia
    sanitization, relative note links, wikilinks, callouts, `==highlight==`, tags
    and the notes' anchor tags.
  - `publish.rs` — `/s/` index and static serving from `/home/dev/throwaway-pages` (or
    `PUBLISHED_DIR`), with slug validation, MIME types, local-time publish
    stamps and canonical confinement.
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
  are served verbatim with extension-based content types → `/s/` lists valid
  page directories by directory mtime, newest first.
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
  (query-string decoding), pulldown-cmark + ammonia (the markdown pipeline),
  log + env_logger (journald-friendly logging), time (published-page
  timestamps).
  Deliberately absent: no database crate, no WebSocket crate, no JS framework,
  no markdown WYSIWYG editor, no CSV crate.
- **Vendored frontend assets** — htmx and a small `app.js` of ours, served from
  `dashboard/assets/js/`; versions and sources recorded in
  `assets/js/VENDORED.md`.
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
  without JavaScript) — no preview/sanitization layer, and published pages
  themselves are still served verbatim. Undo by changing the MIME mapping or the
  index template.
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
