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
| `empty`          | no agents                                                          |

## File fixtures (IDE backend)

`mock-seed` also plants code files so the project-scoped `/api/files/*`
routes are drivable offline:

- `projects/alpha` (plain dir): `README.md`, `src/app.js`,
  `src/lib/helpers.py`, `docs/guide.md`, extensionless `Dockerfile`,
  binary `assets/pixel.png`, oversize `big.log` (> 2 MiB).
- `projects/beta` (git repo): `app.js` (dirty), `README.md`,
  `src/main.go`, `src/nested/deep.json`, binary `assets/icon.png`.
- `projects/notes` stays markdown + CSV only (old viewer surface).

`mock-smoke` asserts the files contract: tree/read/search/commit happy
path, `..` traversal rejection, binary refusal (`415` + `binary: true`),
oversize refusal (`413`), and a write → read → commit+push round-trip on
the notes repo (local bare remote, works offline).

Direct checks (from `dashboard/`, mock server on `:3000`):

```bash
curl -s "localhost:3000/api/files/tree?project=alpha" | head -c 300
curl -s "localhost:3000/api/files/file?project=alpha&path=src/app.js"
curl -s "localhost:3000/api/files/file?project=alpha&path=assets/pixel.png" -w "\n%{http_code}\n"
curl -s "localhost:3000/api/files/file?project=alpha&path=../x" -w "\n%{http_code}\n"
```

## Commands (all from `dashboard/`)

- `npm run mock-seed` — regenerate the fixtures (idempotent; absolute paths
  are stamped per machine, so fixtures are generated, never edited).
- `node scripts/mock-smoke.mjs` — contract test: boots its own mock server
  on :3210 and checks routes, lifecycle events, and a full chat session.
- `npm run typecheck && npm run build` — must pass before any commit.
