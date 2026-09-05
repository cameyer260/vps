# Dashboard work list

Instructions for an agent implementing dashboard changes. Work through the
phases in order, top to bottom — several tasks touch the same files
(`app.css`, `NotesViewer.tsx`, `chat.ts`), so do not parallelize across
phases on one project. Read `AGENTS.md`, `dashboard/ARCHITECTURE.md`, and
`docs/jarvis.md` before starting. After each task, run `npm run typecheck`
in `dashboard/`, rebuild, and redeploy per `dashboard/README.md`.

Do not implement anything in "Future improvements" — that section is
context only.

## Phase 1 — quick wins

1. Fix the conversations list so it scrolls everywhere. On notes it
   currently shows only the top 2 conversations, while on projects it
   expands and scrolls to show all. Both must expand/scroll so every
   session is visible and selectable. Likely a missing
   `max-height`/`overflow-y: auto` on the list in `NotesViewer.tsx`.
2. Make a user-provided session name sticky. When a new conversation is
   created with an optional title set in the start dialog, the UI briefly
   shows pi's auto-generated session title before the real one appears.
   Once the user supplies a name at spawn time (`StartDialog.tsx` already
   sends it), prefer it everywhere and ignore subsequent auto-generated
   `session_info` name updates for that session. Do not break renaming
   sessions that had no explicit name.
3. Redesign the terminate control. The current red X reads as "agent is
   busy/failed", not "shut this agent down". Replace it with a neutral
   stop/power icon (muted gray, red tint only on hover/confirm), keep the
   confirmation step, and make clear it stops the container.
4. Make the app installable as a PWA named "Admin Dashboard":
   - `index.html` title → "Admin Dashboard" (not "jarvis dashboard").
   - Add a web manifest (name, `theme-color`, maskable 192px/512px icons)
     and an apple-touch-icon; create one nice SVG icon and generate the
     PNG set from it. Add a favicon for the Chrome tab.
   - It must look like a proper app when added to a phone home screen.
5. Fix the empty state layout (see
   `/home/dev/screenshots/shot-20260905-173127.png`):
   - The "Agents" title is left-aligned at the top of the main pane, not
     centered.
   - When no agent chat is open, the "no agents running" message and the
     start-agent action are centered inside the component, not floating at
     the top of a large empty area.

## Phase 2 — chat fixes and features

6. Ensure assistant text streams token-by-token. `chat.ts` already handles
   `message_update` events, so streaming should work — if it doesn't,
   diagnose first (bridge buffering docker attach chunks? UI only
   re-rendering on `agent_end`?) and fix the bug rather than building a
   new mechanism. Text must appear incrementally while the agent runs.
7. Model picker toggle: scoped vs all models, defaulting to scoped. The
   current list comes from pi's `get_state` (scoped). Add a toggle at the
   top of the picker; "all" comes from a second source (e.g. server route
   that runs `pi models --json` and caches the output).
8. Skill autocomplete in the chat composer. Typing `/` must open a popup
   listing available skills (name + one-line description from each
   SKILL.md), filtering as the user types, Enter/Tab to insert. Add a
   `GET /api/skills` server endpoint reading the skills directory. Users
   must never have to know exact skill names upfront.
9. Image/file attachments in chat. Add a file picker to the composer,
   upload via a server route (enforce a size cap), pass the content
   through the RPC `prompt` (it already accepts images), and render
   attachment chips in sent messages. Reuse the existing
   provisional-item/backfill logic so reconnects stay correct.

## Phase 3 — notes editor

10. Direct notes editing without spawning an agent. The server endpoints
    already exist (`GET`/`POST /api/notes/file`) — this is frontend work.
    Build a live-preview markdown editor (CodeMirror 6 + markdown
    extensions, or TipTap/Milkdown) into `NotesViewer.tsx`:
    - Open any note and edit it directly; saving POSTs to the existing
      endpoint, debounced.
    - Never drop out of rendered mode while editing — editing must look
      like rendered markdown (live preview, Obsidian-style), not a
      terminal or raw-text pane. This flow's UI is currently the worst
      part of the app; treat it as the priority.
11. CSV view/edit in the notes IDE. Same editor shell as task 10, with a
    spreadsheet-style mode: parse with papaparse, render an editable
    (virtualized if needed) grid, serialize back to CSV on save. It is
    used for an internship-applications tracker, so cell editing is the
    requirement — no need for formulas or a full spreadsheet engine.

## Phase 4 — design rework

12. Full visual redesign of the dashboard. It currently looks bland.
    - Use the `ui-ux-pro-max` skill to drive the restyle.
    - Study the T3 chat repo (open source: https://github.com/t3dotgg/
      t3chat — verify the exact URL) and web sources for its design
      language: dark palette, accent blue, radii, typography, spacing,
      message layout.
    - Keep the black-and-blue scheme but make it feel like a modern agent
      dashboard, not a dull default.
    - Copy the *styling* only — do not port T3 features, buttons, or
      component code wholesale, and respect the repo's license.
    - Do this phase last so it lands on top of the fixed UX from phases
      1–3.

## Future improvements (do not implement now)

These are planned but explicitly out of scope for now. Do not build them;
do not open the door to them while working on the phases above.

- Mobile preview URLs: let an agent expose a localhost server it started
  (e.g. a dev site) at a URL the user can open on their phone to review
  the work. Preferred approach: a dashboard-side reverse proxy
  (`/preview/:agent/:port`) riding the existing Cloudflare tunnel + Access
  auth. Alternative (worse): per-agent `cloudflared` quick tunnels —
  public URLs that bypass Access.
- Bare-metal pi agent option: spawn a regular pi agent directly on the
  host (no jarvis/container) and drive it from the dashboard UI. This
  punches through the container-isolation model the jarvis contract is
  built on; it would need a host-side socket-activated bridge service
  (like `jarvis-git-bridge`), an args/project whitelist, its own doc in
  `docs/`, and an explicit decision on the isolation tradeoff. Note
  jarvis already accepts absolute project paths, which covers most of the
  motivating use case.
