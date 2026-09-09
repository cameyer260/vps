# Mock VPS test harness — implementation plan

## 0. Why this exists

Agents working in containers cannot test the dashboard: no Docker socket, no
`jarvis`, no host mounts (`/home/dev/notes`, pi sessions, gh auth). Today
`npm run dev:server` runs degraded (README: "Docker/jarvis paths are
VPS-only; APIs fail gracefully"), so agents ship frontend work they have
never seen running. This plan builds a `MOCK_VPS=1` mode where the **entire**
dashboard — sidebar, start dialog, streaming chat, model picker, read-only
toggle, notes, git, sessions, terminate — is drivable via Playwright with
zero VPS dependencies.

## 1. Scope guards (read first, enforce throughout)

1. **No behavior change in prod paths.** Mock code is dead code unless
   `MOCK_VPS=1` **and** `NODE_ENV !== "production"`. `getRuntime()` throws at
   boot if `MOCK_VPS=1` with `NODE_ENV=production`. `deploy.sh` never sets
   `MOCK_VPS`.
2. **No new production dependencies.** Verification scripts use node builtins
   (`fetch`, global `WebSocket`) and the Playwright already present via the
   agent image + skills dir. No test runner, no new npm packages.
3. **Seam only, no refactors.** `bridge.ts` keeps its JSONL framing,
   id-rewriting, state cache, and broadcast logic byte-for-byte in behavior;
   only its transport source changes. `routes.ts`, `events.ts`, `index.ts`
   only swap which object they call.
4. **FakePi v1 is closed.** The command/event catalog in §5 is the complete
   v1. New pi event types go through "extend catalog + add golden" later, not
   during this work.
5. **Every phase ends green:** `npm run typecheck && npm run build` before
   moving on.

## 2. Prerequisites

- Read `AGENTS.md`, `dashboard/ARCHITECTURE.md`, `docs/jarvis.md`,
  `dashboard/README.md` (dev section), and the feedback list in `tasks.md`.
- Start from `main` **after** the pending branch is merged + deployed.
- Work on a fresh branch (suggested: `mock-vps`).
- Verified environment facts (do not re-derive): agent containers have
  node ≥ 22, git, and Playwright browsers, with skills mounted ro and the
  sessions dir rw — but **no** Docker socket, **no** jarvis, **no**
  `/home/dev/notes`. `containerState()` in `server/docker.ts` is dead code
  (defined, never called) — leave it alone, the seam does not need it.
- Verified import graph of the seam (the complete list — nothing else
  touches VPS state):
  - `bridge.ts` → `docker()` (attach + `modem.demuxStream`)
  - `events.ts` → `docker()` (event stream)
  - `index.ts` → `containerLabels()` (`/ws/agent/:id` guard)
  - `routes.ts` → `listPiContainers()`, `stopAndRemove()`, `startAgent()`
  - `git.ts` → `runCommand()` — **stays as-is** (git binary exists
    everywhere; fixtures make it work offline, §6).

## 3. Phase 0 — the seam: `server/runtime.ts`

Define the interface every VPS touch-point hides behind:

```ts
export interface SpawnOptions {
  project: string;          // resolved host dir (same value as today)
  sessionPath?: string;     // resume file (validated by the route, unchanged)
  name?: string;            // sticky spawn name → bridge explicitName
  readOnly?: boolean;       // → PI_DASHBOARD_READONLY equivalent
}
export interface AttachedAgent {
  stdin: NodeJS.WritableStream;   // bridge writes JSONL here
  stdout: NodeJS.ReadableStream;  // already-demuxed stdout lines here
  stderr: NodeJS.ReadableStream;  // diagnostics → bridge stderr tail
}
export interface LifecycleEvent {
  action: "start" | "die" | "destroy" | "rename";
  id: string;
}
export interface ContainerRuntime {
  list(): Promise<AgentInfo[]>;                       // → GET /api/agents
  labels(id: string): Promise<Record<string, string> | null>; // → WS guard
  attach(id: string): Promise<AttachedAgent>;         // → bridge
  stopAndRemove(id: string): Promise<void>;           // → terminate route
  spawn(opts: SpawnOptions): Promise<string>;         // → start route (id)
  onLifecycle(cb: (e: LifecycleEvent) => void): () => void;   // → /ws/events
}
export function getRuntime(): ContainerRuntime; // mock iff MOCK_VPS=1 (+ prod guard §1.1)
```

- `DockerRuntime` (same file or `server/runtime-docker.ts`): implement by
  delegating to the existing `docker.ts` / `jarvis.ts` bodies. Move the
  attach + `demuxStream` block out of `bridge.attach()` into
  `DockerRuntime.attach()`; move the `getEvents` loop out of `events.ts`
  into `DockerRuntime.onLifecycle()` (keep its self-resubscribe; return a
  no-op unsubscriber). `bridge.ts` then only wires
  `stdout → onStdout`, `stderr → pushStderr`, `writeToPi → stdin.write`,
  `destroy → stdin.destroy()`.
- Reroute the four call sites (§2). `events.ts`'s `watchDockerEvents()`
  becomes three lines: `getRuntime().onLifecycle((e) =>
  broadcastEvent({ type: "agents_changed", action: e.action, id: e.id }))`.
  Nothing else changes.
- **Acceptance:** `npm run typecheck`, `npm run build`, normal boot;
  with `MOCK_VPS` unset every route behaves exactly as before (spot-check
  `/api/agents`, `/api/projects`, one chat open).

## 4. Phase 1 — `server/mock/runtime.ts` (MockRuntime)

In-memory `Map<string, MockAgent>` where
`MockAgent = { id, project, name, origin, state, startedAt, fakePi }`.

- `list()` → `AgentInfo[]` sorted by `(project, name)` like prod.
- `labels(id)` → `{ "agent.kind": "pi", "agent.project", "agent.origin" }`
  for known ids, `null` otherwise (unknown id → `/ws/agent/:id` closes
  1008, same as prod; exercises the client's terminal-exited path).
- `spawn(opts)` → id `mock-<n>`, `state: "running"`, `startedAt: now`,
  emits `start` lifecycle; creates the FakePi session (with `readOnly` opt
  → startup notify, §5; with `sessionPath` → parse the file's
  `message`/`compaction` entries (with ids) into the entry log and take
  the name from its first `session_info`, so **resume shows history**).
  Returns the id.
- `attach(id)` → fresh stdio pipes bound to that agent's FakePi; rejects
  unknown ids (→ bridge 1011 path, same as prod).
- `stopAndRemove(id)` → close the agent's pipes (drives the bridge's
  `markExited` path exactly like a real stop), `state: "exited"`, emit
  `die` + `destroy`. The terminate route's `bridges.get(id)?.destroy()`
  call is unchanged and still produces the multi-tab `exited` broadcast.
- `onLifecycle(cb)` → in-process emitter set (no resubscribe needed).
- **Acceptance:** boot `MOCK_VPS=1` (no scenarios file yet — seed one
  hardcoded demo agent as fallback); `GET /api/agents` shows it; POST
  start/terminate round-trips; `/ws/events` pushes `agents_changed` for
  both. (Full scenario seeding arrives in §6; MockRuntime loads
  `scenarios.json` when present, else the demo-agent fallback.)

## 5. Phase 2 — `server/mock/fake-pi.ts` (FakePi)

One class per agent session: owns the shared entry log, creates per-attach
stdio pipes, answers one JSONL command per line. Events fan out to **all**
currently attached pipes (two tabs on one chat both stream — the bridge's
multi-client path depends on it). Must answer **internal**
bridge requests (`get_state` with `i<n>` ids) identically to client ones —
the lazy-attach path on `GET /api/agents` depends on it.

### 5.1 Command catalog (v1, closed)

- `get_state` → `{ success: true, data: { model: { provider, id, name },
  thinkingLevel, sessionName, sessionFile } }`, reflecting prior `set_*`.
  Defaults: model `openrouter/mock-sonnet` ("Mock Sonnet"),
  thinkingLevel `"medium"`, sessionName from spawn (or `"mock chat"`),
  sessionFile `<sessionsDir>/mock/<id>.jsonl`.
- `set_model { provider, modelId }` → `data` = full new model object
  (the bridge broadcasts the state notice off this — verified by test).
- `set_thinking_level { level }`, `set_session_name { name }` →
  `{ success: true }` (bridge reads the new value from the command).
- `get_available_models` → `{ models: [...models.json fixture] }`;
  `get_available_thinking_levels` → `{ levels: ["low", "medium", "high"] }`.
- `get_entries { since? }` → `{ entries: [...after since], leafId }`;
  **unknown `since` → `{ success: false, error: "unknown cursor" }`**
  (exercises the client's full-reload fallback).
- `prompt { message, images? }` (images acked, ignored) → immediate
  `{ success: true }`, then the scripted turn (§5.2). Exception: message
  starting with `/read-only on|off` → toggle mode, emit
  `extension_ui_request` notify with the **exact** text the bridge regexes
  (`read-only mode is on` / `read-only mode is off`); bad args → notify
  `usage: /read-only on|off` as warning. Slash commands start **no turn**
  (matches prod: the client sends slashes even mid-turn and never renders
  them).
- `abort` → cancel pending turn timers, emit `agent_settled`,
  `{ success: true }` (the composer's stop button becomes testable).

### 5.2 Scripted turn (data-driven: array of `[delayMs, event]` steps)

`agent_start` → `message_start` (user echo of the prompt) →
`message_start` (assistant) → `text_start` → `text_delta` × N (scripted
prose + prompt echo) → `thinking_start`/`thinking_delta`/`thinking_end`
(short) → `toolcall_start { id: "t1", toolName: "read" }` →
`toolcall_delta` (args JSON) → `toolcall_end { toolCall }` →
`tool_execution_start` → `tool_execution_update { partialResult }` →
`tool_execution_end { result }` → `message_end` (toolResult) →
`message_end` (assistant, content blocks incl. the toolCall) →
`agent_settled`. The tool id (`t1`) must be identical across
`toolcall_start`, `tool_execution_*`, the `toolResult` entry, and the final
assistant content's `toolCall` block — the client matches results to
spinners by it. As events fire, append matching committed `message`
entries with stable ids (`e1, e2, …`) and advance `leafId`, so a mid-turn
backfill shows the correct union with provisional items.

- **Streaming granularity presets** (the point of the exercise):
  `char` (~8 ms/delta), `word` (~40 ms/delta), `instant`. Default per
  scenario (§6). This is what makes the tasks.md "tokens one by one"
  item reproducible and fixable.
- Prompt-while-streaming: buffer at most one pending prompt, run it after
  settle (the client blocks these anyway except slashes).

### 5.3 Startup + stderr

On session creation emit one `extension_ui_request` notify:
`read-only mode is ON|OFF` per the spawn opt (mirrors the real extension's
`session_start`). Seed `stderr` with 2–3 canned lines (`fake-pi ready`,
spawn opts) so `GET /api/agents/:id/logs` renders something in mock mode.

### 5.4 Acceptance

The Phase-4 smoke script's WS section passes; Playwright DOM sampling
shows text growing in `char`-mode increments (§7).

## 6. Phase 3 — fixtures: `scripts/mock-seed.mjs` + `testdata/mock/`

`mock-seed.mjs` is idempotent (`mkdir -p`, safe to rerun; it runs on
 every `dev:mock` boot) and regenerates everything (absolute paths differ
 per machine, so fixtures are **generated, never hand-written**). Append
 `dashboard/testdata/mock/` to `.gitignore`. It creates:

- `projects/alpha/` (plain dir) and `projects/beta/` (git repo with one
  dirty file — for the git-status UI).
- `notes-remote.git` (bare) → `notes/` clone with 3 starter `.md` + 1
  `.csv`, committed and pushed. `git pull` and notes commit+push then work
  fully offline.
- `sessions/`: 2 `.jsonl` files whose header `cwd` is the **absolute
  stamped** fixture project dir (matching the absolute `AGENT_PROJECTS_DIR`
  exported below — `listSessions` compares `header.cwd` to `projectDir()`
  output exactly, and the start route resolves the resume path to absolute
  before checking it is under the sessions dir, so relative paths would
  silently break resume).
  (`{type:"session",id,cwd,timestamp}` + `session_info` + user/assistant
  messages). Required: `listSessions` matches `header.cwd` exactly, and
  the start route only accepts resume paths under the sessions dir ending
  `.jsonl`.
- `skills/`: 2 `SKILL.md` fixtures with `name:` + `description:`
  frontmatter.
- `models.json`: 3 models (`provider,id,name,contextWindow`) — served by
  `/api/models` **in mock mode only** (deterministic; do not change the
  prod `pi --list-models` behavior) and by FakePi's `get_available_models`.
- `scenarios.json`: `sidebar-full` (default: 3 agents across two projects,
  mixed origins — include at least one `dashboard`-origin running agent so
  the lazy-attach path on `GET /api/agents` is exercised at seed),
  `chat-streaming` (1 agent with preloaded history — scenario entries may
  carry a `history` array of entry objects loaded into the FakePi entry log
  at seed — `char` granularity), `notes-editor`, `empty` (no agents — the bare
  homepage state from the tasks.md feedback). `MOCK_SCENARIO=name`
  selects; unknown name → fail fast with the valid list.

`dev:mock` script (add to `package.json`; **absolute paths** — see the
resume/`cwd` note above):

```json
"mock-seed": "node scripts/mock-seed.mjs",
"dev:mock": "npm run mock-seed && MOCK_VPS=1 MOCK_SCENARIO=${MOCK_SCENARIO:-sidebar-full} NOTES_DIR=$(pwd)/testdata/mock/notes AGENT_PROJECTS_DIR=$(pwd)/testdata/mock/projects PI_SESSIONS_DIR=$(pwd)/testdata/mock/sessions AGENT_SKILLS_DIR=$(pwd)/testdata/mock/skills tsx watch server/index.ts"
```

- **Acceptance:** in a clean checkout, `npm ci && npm run dev:mock` →
  `/api/projects`, `/api/sessions?project=alpha`,
  `/api/notes/tree`, `/api/models`, `/api/skills` all return fixture data;
  notes write + commit/push and `git pull` succeed offline.

## 7. Phase 4 — verification tooling

- `scripts/mock-smoke.mjs` (node builtins only — `fetch` + global
  `WebSocket`, no deps): runs `mock-seed` if `testdata/mock` is missing,
  spawns the mock server on an ephemeral port (`PORT=3210`), polls
  `/api/projects` until ready, then asserts HTTP routes
  (projects, agents, sessions, models, skills, notes tree/file/search,
  upload), asserts `/ws/events` delivers `agents_changed` on spawn +
  terminate, then over `/ws/agent/:id` asserts `hello` → backfill returns
  entries → `get_state` round-trip → `prompt` produces `agent_start …
  agent_settled` → `set_model` broadcasts a state notice. Kills the server
  and exits non-zero on any failure. This is the fast loop and the
  contract test.
- `scripts/assert-stream.mjs` (Playwright, see the `playwright-browser`
  skill for invocation; `BASE_URL` env, default `http://localhost:5173`): opens the `chat-streaming` scenario, sends a
  prompt, samples the rendered assistant text on a timer, and reports the
  chunk-size distribution — the oracle for the tasks.md streaming item
  ("tokens one by one" ⇔ small median chunk + many intermediate paints).
- `docs/testing.md`: the loop doc — two terminals (`dev:mock` + `dev:web`,
  Playwright targets Vite at :5173) → run smoke → Playwright
  flows **including iPhone device emulation for the mobile backlog** →
  screenshot → fix → repeat; scenario table mapping each tasks.md feedback
  item to its scenario + assertion; definition of done per fix (smoke green
  + screenshots attached to the report). Link it from
  `dashboard/README.md`'s dev section (2 lines). If agents ignore the doc
  in practice, add a `test-dashboard` skill as follow-up (not in v1).
- Stretch (document, do not build): golden recordings — capture a real
  `pi --mode rpc` stdio session on the host into
  `testdata/mock/golden/*.jsonl` plus a FakePi replay mode. This is the
  long-term anti-drift mechanism; v1 ships scripted.

## 8. Phase 5 — first use

Drill the tasks.md feedback list through the harness (streaming
granularity, `/tree`, session/context info, git/worktree info, homepage
buttons, agent-panel UI, agent naming/rename, mobile layout). Product
calls (naming, renames) stay with the user per item, as today. Merge to
`main` + deploy when green; post-deploy, run the live smoke (start a real
agent via the deployed dashboard, send a prompt, verify streaming, stop
it) — mock covers development, live smoke covers integration.

## 9. Explicitly out of scope

Cloudflare tunnel/Access, `gh` auth, the git-bridge socket, real jarvis
flag quirks, prod `/api/models` fallback changes, golden replay (stretch),
the Rust port (separate tasks.md item), mobile preview URLs (separate
tasks.md item).

## 10. Risks

- **Mock drift from the real pi protocol** → contained by the closed
  catalog (§5.1), golden recordings (stretch, §7), and the per-deploy live
  smoke (§8).
- **FakePi scope creep** → the catalog is closed for v1; anything beyond
  it is a new proposal, not a drive-by addition.
- **Agents not using the loop** → `docs/testing.md` is written as
  ordered steps with copy-paste commands, linked from the README; skill
  follow-up if needed.
