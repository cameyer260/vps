# Testing the dashboard (mock-VPS loop)

The dashboard normally needs the VPS (Docker socket, `jarvis`, host mounts),
so `npm run dev:server` runs degraded anywhere else. `MOCK_VPS=1` mode swaps
the container seam for scripted fakes — the **entire** dashboard (sidebar,
start dialog, chat, model picker, read-only toggle, notes, git,
sessions, terminate) becomes drivable with zero VPS dependencies.

## Setup (two terminals, copy-paste)

```bash
# terminal 1 — mock API (reseeds fixtures every boot)
cd dashboard
MOCK_SCENARIO=sidebar-full npm run dev:mock   # Hono on :3000, mocked

# terminal 2 — real SPA against the mock API
cd dashboard
npm run dev:web                               # Vite on :5173, proxies /api + /ws to :3000
```

## Scenarios (`MOCK_SCENARIO=name`; unknown names fail fast with the list)

| Scenario         | Seeds                                                              |
|------------------|--------------------------------------------------------------------|
| `sidebar-full`   | 3 agents across 2 projects, mixed origins, one read-only           |
| `chat-streaming` | 1 agent with preloaded history; replies stream character by character |
| `notes-editor`   | 1 agent on the notes project                                       |
| `gc-chat`        | 1 read-only GC notes agent with history + 2 seeded notes sessions  |
| `empty`          | no agents                                                          |

## File fixtures (IDE backend)

`mock-seed` also plants code files so the project-scoped `/api/files/*`
routes are drivable offline:

- `projects/alpha` (plain dir): `README.md`, `src/app.js`,
  `src/lib/helpers.py`, `docs/guide.md`, extensionless `Dockerfile`, dotfile
  `.gitignore`, binary `assets/pixel.png`, oversize `big.log` (> 2 MiB).
- `projects/beta` (git repo): `app.js` (dirty), `README.md`,
  `src/main.go`, `src/nested/deep.json`, binary `assets/icon.png`, ignored
  `dist/bundle.js` (via a committed `.gitignore` — shown greyed out, not hidden).
- `projects/notes` stays markdown + CSV only (old viewer surface).

`mock-smoke` asserts the files contract: tree/read/search/commit happy
path, `..` traversal rejection, binary refusal (`415` + `binary: true`),
oversize refusal (`413`), dotfiles shown and readable as text, git-ignored
paths flagged `ignored: true`, and a write → read → commit+push round-trip on
the notes repo (local bare remote, works offline). Content search skips
dependency/build/output dirs (node_modules, .git, dist, .next, …) while the
tree itself ignores nothing.

Direct checks (from `dashboard/`, mock server on `:3000`):

```bash
curl -s "localhost:3000/api/files/tree?project=alpha" | head -c 300
curl -s "localhost:3000/api/files/file?project=alpha&path=src/app.js"
curl -s "localhost:3000/api/files/file?project=alpha&path=assets/pixel.png" -w "\n%{http_code}\n"
curl -s "localhost:3000/api/files/file?project=alpha&path=../x" -w "\n%{http_code}\n"
```

## General Chat backend (GC flag)

`POST /api/agents/start` accepts `generalChat: true`: the spawn is forced
to the notes project, defaults to `readOnly: true` unless explicitly passed
`readOnly: false`, and (in prod) appends `server/general-chat.ts`'s
`GENERAL_CHAT_SYSTEM_PROMPT` via `jarvis rpc`'s `--append-system-prompt`
passthrough — the same mechanism as `AGENT_CONTEXT`. The prompt lives
server-side only, never in the client bundle; project agents are untouched.
The mock records the flag on `FakePi` (visible as `general-chat: on/off` in
`GET /api/agents/:id/logs`) and otherwise behaves identically.

`mock-smoke` asserts the GC contract: forced-notes project, read-only
default + explicit opt-out, bad-`sessionPath` rejection, and that plain
(non-GC) spawns stay read-only-off with no GC flag.

Direct checks (from `dashboard/`, mock server on `:3000`):

```bash
curl -s -X POST localhost:3000/api/agents/start \
  -H 'Content-Type: application/json' -d '{"generalChat":true}'
# → {"project":"notes","generalChat":true,...} (read-only on by default)
curl -s -X POST localhost:3000/api/agents/start \
  -H 'Content-Type: application/json' \
  -d '{"generalChat":true,"project":"alpha"}'
# → project still "notes" (GC forces the notes dir)
```

## Host agents (Jarvis toggle off)

`POST /api/agents/start` accepts `runtime: "host"` + `directory` (absolute
path under `/home/dev`, validated by `resolveHostDir` — the home-prefix check
is skipped under `MOCK_VPS=1` so fixture dirs validate offline). Host spawns
reject `generalChat` and ignore `readOnly` (no read-only extension on the
host). `GET /api/host-validate?path=` powers the modal's green/red dot;
`GET /api/sessions?directory=` feeds the conversation picker. The mock
records host spawns as `host-mock-<n>` ids with `runtime: "host"` +
`directory` (same `FakePi` chat flow otherwise).

`mock-smoke` asserts the host contract: validate ok/missing/file,
sessions-by-directory, spawn id/directory/runtime, `agents_changed` start,
list row with `runtime`+`directory`, backfill over `/ws/agent/<host-id>`,
missing/bad-dir/`generalChat` rejections, and terminate → destroy → drop.

Direct checks (from `dashboard/`, mock server on `:3000`):

```bash
curl -s "localhost:3000/api/host-validate?path=$(pwd)/testdata/mock/projects/alpha"
# → {"ok":true,"directory":".../alpha","project":"alpha"}
curl -s -X POST localhost:3000/api/agents/start \
  -H 'Content-Type: application/json' -d '{"runtime":"host","directory":"'$(pwd)'/testdata/mock/projects/alpha"}'
# → {"id":"host-mock-N","project":"alpha","directory":"...","runtime":"host",...}
```

## Commands (all from `dashboard/`)

- `npm run mock-seed` — regenerate the fixtures (idempotent; absolute paths
  are stamped per machine, so fixtures are generated, never edited).
- `node scripts/mock-smoke.mjs` — contract test: boots its own mock server
  on :3210 and checks routes, lifecycle events, and a full chat session.
- `npm run typecheck && npm run build` — must pass before any commit.
