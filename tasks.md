# Dashboard work list

Phased so items that touch the same files don't stomp each other. Work top
to bottom; don't parallelize across phases on one project.

## Phase 1 — quick wins

- Conversation resume on notes only shows the top 2 conversations while on
  projects it will expand and let you scroll down to see them all. Both
  should expand/scroll to let you see and pick from all.
- Session title race: when I first created a new conversation under a
  project, even though in the creation tab I entered an optional title it
  still showed some random auto generated one rather than the title I had
  set. It took a little bit for that title to be shown properly. A
  user-provided name should be sticky — pi's auto-generated session title
  must not overwrite it.
- The red x button to shut down the agent is misleading — it makes you think
  the agent is currently running, like working and/or generating response. I
  want to be able to click a button and shut down agents but not one that
  looks like that. Neutral power/stop icon, red only on confirm.
- Add an icon for chrome, and make sure that the PWA version of the web app
  (which will show up like a mobile app on my phone, for
  admin.christophermeyer.dev) has a name and an app icon just like a regular
  app. I'd like it to look nice. So the title for the page needs to be
  updated as well. Name it "Admin Dashboard" and not "jarvis dashboard".
- Empty-state fixes (part of the design rework): the agents title needs to be
  left aligned, and when there is no agent chat pulled up, the "no agents
  running" and start agent should be in the center of the component. See
  `/home/dev/screenshots/shot-20260905-173127.png`.

## Phase 2 — bug fix, then chat features

- Streaming: the text in conversations should stream as the tokens are
  generated if possible. `chat.ts` already handles `message_update` events,
  so if it doesn't feel streamed, find and fix the buffering/render bug
  first instead of building anything new.
- Picking from the models on the top right should let you toggle scoped
  models or all models, defaulting to scoped.
- Skills need to show up when you type them out — you are left in the dark
  right now as to what they are. Like you need to know exactly what they are
  called and type them out that way. Add a `/`-triggered autocomplete popup
  listing skill names + descriptions.
- Image/file attachments in chat (pi's `prompt` already accepts images; this
  is plumbing, not protocol work).

## Phase 3 — notes editor

- You shouldn't have to spawn an agent to edit the notes — you should be able
  to just open the notes ide and edit that way (the `/api/notes/file` GET and
  POST endpoints already exist; this is a frontend gap). Editing should not
  leave rendered mode — the entire time it should be rendered, not look like
  a terminal, even when editing. The uiux for this flow is especially bad.
  Live-preview markdown editor (CodeMirror 6 or TipTap), debounced save.
- Support csv file view/edit in notes ide so I can view/edit my
  applications csv for internship applications. Same editor shell, editable
  grid mode.

## Phase 4 — design rework

- Full design rework. It looks bland right now. Use uiuxpromax skill. Try to
  mimic T3 chat styling — give it the t3 chat repo link (it's open source)
  and have it make web searches to find information on that. I don't mind the
  black and blue color scheme but it is too dull and bland right now; needs a
  modern agent dashboard look. Mimic that look where applicable (without
  copying his application or adding features and buttons that don't belong on
  mine — the styling is what gets copied, mind the repo's license). I don't
  like the current look of the frontend, especially when there are no agents
  running. Do this last so it lands on top of the fixed UX, not under
  everything that comes after.

## Future improvements (do not implement now)

- Mobile preview URLs: an agent should be able to forward a localhost server
  to a public endpoint so that, when it is developing a site, from my phone,
  I can click a url it provides and use that site on my phone. Preferred
  approach is a dashboard-side reverse proxy (`/preview/:agent/:port`) riding
  the existing Cloudflare tunnel + Access auth; cloudflared quick tunnels as
  an alternative (bypasses Access — worse hygiene).
- Bare-metal pi agent option: a regular no-container pi agent. This is a
  special case, not a regular agent/jarvis spawn — literally spawning pi
  anywhere on the machine and providing ui for it in the dashboard, so I
  don't have to do so in termius. Punches through the container-isolation
  model; needs a host-side socket-activated bridge service and its own doc,
  plus a deliberate decision on the isolation tradeoff. Cheaper middle
  ground: jarvis already accepts absolute project paths, which covers most of
  the use case.
