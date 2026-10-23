# Admin Site: Product Requirements

## Overview

A single-user web app at `admin.christophermeyer.dev`, running on the VPS next
to the notes repo. It renders the notes repo as an Obsidian-quality document
browser (read-only) and publishes throwaway pages — agent-made visuals,
prototypes, demos — at subroutes, so they can be opened from a phone or
laptop. It runs as a native systemd user service on port 3000, and its only
route from outside is the existing Cloudflare tunnel, gated by Cloudflare
Access to the owner's account.

## Problem & Users

One user: the owner, who works from a phone and a Mac over Tailscale and keeps
his notes as plain markdown in a git repo at `/home/dev/notes`.

The problems this solves:

- Notes can only be read in a terminal or editor. There is no rendered,
  comfortable reading view away from a shell.
- Agent-made visuals and prototypes have nowhere to be seen. An agent can run
  a dev server bound to localhost on the VPS, but that is unreachable from a
  laptop or phone; the alternative is pulling the repo and building on the Mac.
- The previous surface for this (a TypeScript agent-management dashboard) is no
  longer used — agents run from `herdr` — and has been torn down.

Success looks like: from the phone, open the site, read any note the way
Obsidian would render it, find a note by searching, and open a URL an agent
produced to see either a visual or a live dev server — with no pull or build
step on the owner's side.

## Goals / Non-goals

Goals:

- **G1 — Obsidian-quality reading of the notes repo, read-only.** The bar is
  how Obsidian renders a vault, not "markdown renders somehow".
- **G2 — Find a note fast**, by browsing the tree and by searching for a note
  by name or path.
- **G3 — Review agent work from any device**: one URL for a published page or
  for a running dev server.
- **G4 — Host tooling has a maintained home** with its setup documented.

Non-goals for this version:

- Editing notes from the browser (autosave, drafts, conflict handling, git UI).
- Agent management, chat, terminals, sessions (agents run from `herdr`).
- Public publishing, sharing, multiple users, per-page permissions.
- Per-app subdomains, on-demand tunnels, Cloudflare Pages / wrangler deploys.
- Obsidian plugin parity: graph view, backlinks pane, canvas, note embeds,
  mermaid, math.

## Features

### 1. Notes browser (read-only)

**Behavior**

1. Opening the site shows a sidebar with the notes file tree (folders first,
   alphabetical) and a reading pane. The tree reads like Obsidian's file
   explorer: top-level rows are flush with the folder chevrons, a folder's
   children are indented behind a vertical guide line dropped from its chevron,
   and the chevron rotates when the folder opens. Names keep their extension.
2. Folders expand and collapse; clicking a `.md` file opens it in the reading
   pane. In-site navigation swaps the reading pane rather than reloading the
   page: the URL updates, the sidebar keeps its scroll, its filter text and its
   open folders, and the tree keeps the open note highlighted. A link can point
   anywhere in the vault, so the folders above the note it opens are expanded
   too, and the highlighted row is never left hidden inside a collapsed folder.
   Only that chain is expanded — folders opened by hand stay open. The vault
   name in the sidebar header is a link home, back to the empty first screen.
3. The reading pane renders the note with Obsidian's reading-view look:
   - frontmatter renders as a properties block (`file`, `last_updated`), not
     raw YAML;
   - headings, paragraphs, lists, task lists, tables, blockquotes, code blocks
     and inline code, links, images, footnotes, `==highlight==`, `#tags`,
     callouts, wikilinks;
   - anchor tags written into raw HTML (`<a id="section"></a>`) survive
     rendering, so a same-note link such as `[jump](#section)` still reaches
     its anchor;
   - relative links to other notes navigate within the site rather than
     pointing at a file path — wherever they point relative to the note:
     `main.md`'s `[Context 013](extended-context/013-centene-interview-prep.md)`
     into the `extended-context/` folder, or that note's
     `[centene-interview-prep.md](../internship/company-specific/centene-interview-prep.md)`
     back out of it;
   - wikilinks resolve to notes in the repo where a target exists, and render
     visibly distinct where it does not.
4. Non-markdown files in the notes directory (PDFs, PNGs, CSVs, text) appear in
   the tree beside the notes. Clicking one that would download — anything that
   is not a PDF or a raster image — opens a centred dialog first ("CSV files
   can't be opened in this editor. Download instead?") with a Download button
   and an × in the corner. It closes on the ×, on Escape, on a click outside
   the box, or by itself after five seconds. PDFs and images still open inline,
   and the Download button serves the file as an attachment.
5. Search is live. Typing in the filter box narrows the tree to the notes whose
   name or relative path matches it (case-insensitive substring) after a short
   pause from the last keystroke — no Enter, no page reload. While a query is
   active the tree shows a flat result list; clearing the box restores the full
   tree. The reading pane is untouched by a search, and attachments are not
   results. Note contents are never searched.
6. A boxed link at the top right of the reading pane opens `/s/`, and the
   published-pages index carries the mirrored boxed link back to `/`. The box
   sits on the pane's first row — level with the sidebar's header, so it reads
   as the same top bar — and stays in the scrolling content, so it scrolls
   away with the note rather than floating.

**Rules & edge cases**

- The notes root is fixed at `/home/dev/notes` (env-overridable; default is
  the host path).
- Dotfiles and dot-directories (`.git`, `.obsidian`) are hidden from the tree,
  and hidden entries are not search results either.
- Search matches names and paths only. No request scans note contents for a
  query, and there is no search index.
- The app never writes to the notes repo: no write endpoints, read-only file
  access.
- Request paths resolve under the notes root; `..`, absolute paths, and
  symlinks that escape the root are rejected with a 404 rather than surfacing a
  filesystem error.
- A symlinked note inside the repo (`CLAUDE.md → AGENTS.md`) renders like any
  other note and cannot cause a loop.
- Files above 1 MiB are not rendered inline — the note route shows a size-limit message and a download link; the download route sends them as attachments.
- Non-UTF-8 Markdown is decoded lossily and never panics. PDF, PNG, JPEG, GIF and WebP attachments are served inline with their MIME types; SVG, text, unknown types and other non-image attachments download with `Content-Disposition: attachment` (unknown types use `application/octet-stream`).
- Rendered HTML is sanitized. Markdown-generated elements remain, as do note anchor links, task-list checkboxes and code classes. Scripts, event-handler attributes, `javascript:` URLs, `style` and other raw HTML do not survive sanitization.
- Mobile: the sidebar collapses behind a toggle button; the sidebar header
  clears that button both to the left and vertically, so the button never covers
  the vault name and has the same room above it as below it — it is centred in
  the header, not flush with its bottom border. Tapping outside the
  open sidebar closes it, exactly as tapping the toggle does. The reading pane
  is comfortable at phone width and wide tables scroll inside their own
  container.
- The site has a mark — the blue open book on the app's own `#1e1e1e` — and it
  is what the browser tab shows, what a phone puts on the home screen, and what
  the installed app opens with. Every page declares the whole set: the SVG for
  browsers that take it, the ICO and the 16/32px PNGs for the rest, the 180px
  PNG for iOS, and the web app manifest. The declared URLs carry the asset
  fingerprint, so a browser caches each file until it actually changes — and a
  replaced icon reaches a home screen on the next add rather than sticking at
  whatever iOS cached under the old URL.
- The manifest names the app after the vault (`notes — admin`, with `notes`
  under the home-screen icon), gives it `#1e1e1e` for its chrome and its splash,
  and asks for a standalone window — so an installed app opens without browser
  chrome and its status bar matches the icon's tile. Adding it to the home
  screen needs no service worker and there is no offline mode: the notes are
  live.
- Installed on a phone (iOS "Add to Home Screen"), the app keeps a solid status
  bar: the top of the screen shows the page's own background, never the system
  blur band that iOS otherwise draws over an installed web app. The strip that
  does it is reserved space rather than an overlay — the shell starts 8px below
  the top of the screen in that mode — so no content is ever clipped or covered
  by it: the boxed link, the sidebar toggle and the sidebar overlay all sit
  clear of it. Both the notes page and the published-pages index carry it, and
  it is absent everywhere the blur cannot appear — in every browser, and in a
  desktop-installed app — so the browser rendering is unchanged.
- The filter and the navigation work without JavaScript: the form submits to
  `/search`, which answers with the filtered tree on a full page.
- Clicking a link to a non-markdown file inside a note still downloads or opens
  that file rather than swapping it into the reading pane.

**Acceptance criteria**

- `main.md` renders with its headings and lists styled; a `Context` link such as `[Context 013](extended-context/013-centene-interview-prep.md)` renders as an in-site `/notes/extended-context/…` link and the linked note renders rather than 404ing.
- A note with frontmatter shows a properties block with `file` and
  `last_updated`, not raw `---` YAML.
- GFM task lists render as non-interactive checkboxes; a GFM table renders as
  a table.
- A traversal-shaped path and a symlink pointing outside the notes root both
  return 404.
- Searching for a filename fragment returns the matching notes; searching for a
  directory name returns the notes under it; a phrase that appears only in note
  *contents* returns nothing; a query with no matches shows an empty state.
- Typing a filename fragment narrows the tree without an Enter press, and the
  tree is not reloaded between keystrokes.
- Clicking a CSV row shows the dialog naming its type, and its Download button
  downloads the file; a PNG or PDF row still opens inline.
- Clicking the vault name returns to the empty first screen, and the boxed link
  at the top right of the pane opens `/s/`.
- A page of the tree keeps its filter text and open folders across an in-page
  navigation, and a link to a non-markdown file inside a note still downloads
  it.
- Following a link to a note inside collapsed folders expands the folders above
  it, leaves the folders the reader opened alone, and ends with the note
  highlighted in the tree — on a whole page load and on an in-page navigation
  alike.
- No request can modify anything under the notes root (tests assert there are
  no write endpoints, and that reads are read-only).
- Typography and color come from Obsidian's documented values: 700px readable
  column, 16px text, its heading scale, base palette and text tiers.
- Both pages carry the status-bar strip element, and it is `display: none` in a
  browser: a phone-width browser render is pixel-identical to before.
- Both pages declare the icon set and the manifest in their head, at
  fingerprinted `/static/icons/…?v=` URLs that serve their file with the right
  content type and the year-long immutable cache every other asset gets. The
  same seven files also answer at the site root — `/favicon.ico`,
  `/favicon.svg`, `/favicon-16x16.png`, `/favicon-32x32.png`,
  `/apple-touch-icon.png`, `/icon-192.png`, `/icon-512.png` — with an hour's
  cache, for clients that never read the head, and nothing else is readable
  through that route.
- `/site.webmanifest` parses as JSON and carries the vault's name,
  `display: standalone`, `#1e1e1e` for both colours, and 192px and 512px icons
  declared `any maskable`, named by their fingerprinted URLs, that are
  themselves served; a vault name containing a quote or a backslash still
  yields a valid manifest.
- Attachments appear as files in the tree; PDF, PNG, JPEG, GIF and WebP are served inline with MIME types, while SVG, text, unknown and other formats download with attachment disposition. Files over 1 MiB shown through the note route instead get a size-limit message and explicit download link.

### 2. Static publishing (`/s/<slug>/`)

**Behavior**

1. An agent writes a directory of files — `index.html` at minimum, optionally
   CSS, JS, images — into `/home/dev/throwaway-pages` (`PUBLISHED_DIR` overrides).
2. The page is live at `https://admin.christophermeyer.dev/s/<slug>/`, with
   `index.html` served at the directory URL and sibling assets served from the
   same directory.
3. Every HTML document under the slug — `index.html` or any other page — is
   served with a back arrow at the top left of the screen that returns to
   `/s/`. It is a boxed button styled like the notes page's sidebar toggle,
   with a back arrow in place of the file-tree icon; it floats over the page
   (`position: fixed`, 8px in from the top and left plus the safe-area insets,
   above the page's own content) and takes no part in the page's layout. The
   page's own content is untouched.
4. `/s/` lists published pages — slug, publish time (directory mtime), newest
   first, each linking to the page. Deleting the directory removes both the
   page and its index entry. Nothing expires automatically. The index is
   dressed like the notes pages — same dark theme, same reading column, same
   boxed link — with a boxed "Notes" link back to the notes site, and each
   publish time rendered in the reader's own timezone as `YYYY-MM-DD h:mm
   AM/PM` (the markup carries the UTC instant, which is also what a reader
   without JavaScript sees).

**Rules & edge cases**

- Slugs are 1–64 ASCII characters matching `[a-z0-9][a-z0-9-]*`; validation is
  enforced because a slug is a URL segment. Invalid names and non-directory
  entries in the root are ignored, never served or listed.
- Published files are served as-is, including scripts — no sanitization —
  with one addition: the back arrow is injected into every HTML document (one
  carrying a doctype or an `<html>`, `<head>` or `<body>` tag) as it is served.
  Nothing on disk is written, and HTML fragments and non-HTML files are served
  byte-for-byte. They are all inside the Access boundary.
- The server never exposes a raw filesystem listing; `/s/` is the only index.
- Path traversal and symlink escapes are rejected, same as the notes side.
- The app never writes to the published root: publishing, updating and
  removing a page are file operations on the host, and replacing a slug's
  directory contents replaces what is served. There are no versions.
- A missing published-pages directory yields an empty index, not an error.

**Acceptance criteria**

- Writing `/home/dev/throwaway-pages/demo/index.html` makes `/s/demo/` serve it and lists `demo`
  on `/s/` with its time.
- `~/throwaway-pages/demo/app.js` is served at `/s/demo/app.js` with a JavaScript content
  type.
- Traversal-shaped paths under `/s/` return 404.
- Deleting the directory removes it from `/s/`.
- `/s/` renders with the site stylesheet: the dark background, the reading
  column, a "Notes" boxed link back to `/`, and each page's time in the
  reader's local timezone.
- A `<script>` in a published page executes (as-is serving).
- A published page's HTML carries exactly one back arrow, right after its
  `<body>` tag (or at the end of a document that has no body tag), and the
  page's own content is otherwise unchanged; an HTML fragment, a script, a
  stylesheet or an image under the slug is served byte-for-byte.

### 3. Dev-server review skill

**Behavior**

1. The owner asks for a review of a web app an agent is developing.
2. The agent starts the app's dev server on port 4173, serving plain HTTP.
3. The agent tells the owner to open `https://dev.christophermeyer.dev` —
   Access-gated to the owner's account.
4. When the owner is done, the agent stops the server.

**Rules & edge cases**

- Used only when the owner asks. The agent's own self-review loop is unchanged:
  localhost plus Playwright.
- One dev server at a time. The tunnel route is a fixed port, so shifting ports
  is not an option; if a stale server already holds port 4173 the skill reports
  it to the owner (process, command line, PID) and waits for his decision — shut
  it down, or leave it alone — before starting a new one.
- Plain HTTP locally: a self-signed HTTPS origin fails through the tunnel.
- Vite-based dev servers need `server.allowedHosts` to accept the tunneled
  hostname (its default blocks unknown hosts), and their HMR client pointed at
  the public origin (`server.hmr = { protocol: 'wss', clientPort: 443 }`) since
  the page's port and the local server port differ.
- HMR/WebSocket through the tunnel works: cloudflared forwards the public
  hostname as the origin `Host` and passes WebSocket upgrades, so live reload
  reaches the phone (verified through the dev-review route; ARCHITECTURE.md has
  the setup).
- Apps must use relative URLs; an absolute `http://localhost:4173` base breaks
  when viewed through the tunnel.
- The skill carries the tunnel context (what the hostname is, that it is
  Access-gated, that it is one port) so the agent doesn't have to rediscover it.

**Acceptance criteria**

- From the phone, `https://dev.christophermeyer.dev` shows a dev server
  an agent started on 4173, after the Access login.
- After the agent stops it, nothing is left listening on 4173.
- A second review session cannot start on top of a stale server: the skill's
  first step detects the existing listener and stops to ask the owner before
  anything is killed.
- HMR/live reload reaches the phone through the tunnel, and the setup that
  makes it work is written down in ARCHITECTURE.md.

### 4. Agent skill hosting

**Behavior:** `skills/publish-page/` and `skills/review-dev-site/` live in this
repo and are symlinked into both `~/.agents/skills/<name>` (pi) and
`~/.claude/skills/<name>` (Claude Code), so agents on this host discover them
by name and description.

**Rules:** the symlinks point at the `~/vps` deploy checkout, matching how the
`tools/prune-screenshots.*` units are registered; a skill change is committed,
pulled into `~/vps`, and takes effect there. Skill frontmatter names and
descriptions are what trigger them, so they must say plainly when the skill
applies and, for the review skill, that it is owner-invoked only.

**Acceptance criteria:** both agents list both skills after registration; a
fresh session triggers the right one from its description; the symlinks resolve
into `~/vps/skills/`.

### 5. Screenshots inbox pruning

**Behavior:** the Mac screenshot tool scps captures to `/home/dev/screenshots`
(`SCREENSHOTS_DIR` overrides). A daily systemd user timer runs
`tools/prune-screenshots.sh`, which deletes captures older than 7 days
(`SCREENSHOTS_RETENTION_DAYS` overrides) and exits quietly when the inbox does
not exist yet. Installation commands are in the README.

**Acceptance criteria:** `systemctl --user status prune-screenshots.timer`
reports it active; `journalctl --user -u prune-screenshots.service` shows runs;
captures older than the retention window disappear.

## Non-functional requirements

- **Access.** Every route — the site, published pages, dev review — is
  reachable only through Cloudflare Access, limited to the owner's account. The
  app itself has no accounts, sessions, or login.
- **Privacy.** Notes and published artifacts never leave the machine except via
  Cloudflare's edge for the owner's own requests. No third-party fetches: assets
  vendored, no CDN, no webfonts, no analytics.
- **Safety.** No write path into the notes repo; every served path root-confined.
- **Performance.** Server-rendered HTML, one response per page; search matches
  against names and paths, so it never reads note contents and returns
  instantly.
- **Mobile-first.** The phone is the primary client: tappable rows, collapsing
  sidebar, no horizontal page scroll.
- **Ops.** One binary, one systemd user unit, no database, no Node runtime on the
  host, logs to journald, restarts on failure and comes back after boot.
- **Observability.** `journalctl --user -u admin.service` is the log; a health
  endpoint backs the service check.
- **Platform.** Ubuntu 24.04, unprivileged `dev` user, systemd user units,
  existing Cloudflare tunnel + Access.
- **Licensing.** Private repo. Third-party crates and vendored assets keep their
  own licenses, recorded where vendored.

## Constraints & assumptions

- No Cloudflare API token exists on the host: tunnel routes and Access hostnames
  are dashboard changes made by the owner. Nothing in this project can create
  them programmatically.
- `rustup`/`cargo` and the Tailwind standalone CLI are already installed on the
  host.
- `/home/dev/notes` is a git repo synced with GitHub. The app only reads it, so
  it cannot dirty git state.
- The VPS has 2 vCPU, ~8 GB RAM, no swap: one heavy build at a time.
- Tailscale is the normal way to reach the machine, and the site is reachable
  over Tailscale by IP and port as a fallback if Cloudflare is down.
