#!/usr/bin/env node
/**
 * Fast contract test for the mock-VPS harness (mock-VPS plan, Phase 4).
 *
 * Node builtins only (`fetch` + global `WebSocket`, no deps). Runs
 * `mock-seed` if `testdata/mock` is missing, spawns the mock server on PORT
 * (default 3210), polls `/api/projects` until ready, then asserts HTTP routes,
 * `/ws/events` lifecycle push, and the full `/ws/agent/:id` chat flow. Kills
 * the server and exits non-zero on any failure.
 *
 * Usage:  node scripts/mock-smoke.mjs   (from dashboard/)
 *         PORT=3210 node scripts/mock-smoke.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dashboardDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mockDir = path.join(dashboardDir, "testdata/mock");
const PORT = Number(process.env.PORT ?? 3210);
const base = `http://localhost:${PORT}`;

let passed = 0;
function check(name, cond, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name}${extra ? ` — ${extra}` : ""}`);
  passed++;
  console.log(`ok: ${name}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getJSON(p) {
  const r = await fetch(base + p);
  if (!r.ok) throw new Error(`GET ${p} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function postJSON(p, body) {
  const r = await fetch(base + p, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) throw new Error(`POST ${p} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

/** Wait for the next WS message matching pred (parsed JSON). */
function wsWait(ws, pred, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMsg);
      reject(new Error(`timeout waiting for ${label}`));
    }, timeoutMs);
    const onMsg = (e) => {
      let m;
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (pred(m)) {
        clearTimeout(timer);
        ws.removeEventListener("message", onMsg);
        resolve(m);
      }
    };
    ws.addEventListener("message", onMsg);
  });
}

function wsConnect(p) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace("http", "ws") + p);
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", () => reject(new Error(`WS connect failed: ${p}`)), { once: true });
    setTimeout(() => reject(new Error(`WS connect timeout: ${p}`)), 10_000);
  });
}

let server = null;
function killServer() {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    server = null;
  }
}
process.on("SIGINT", () => {
  killServer();
  process.exit(130);
});

try {
  // ---- fixtures -----------------------------------------------------------
  if (!fs.existsSync(path.join(mockDir, "scenarios.json"))) {
    console.log("smoke: testdata/mock missing — running mock-seed");
    const seeded = spawnSync("node", ["scripts/mock-seed.mjs"], { cwd: dashboardDir, stdio: "inherit" });
    if (seeded.status !== 0) throw new Error("mock-seed failed");
  }

  // ---- boot ---------------------------------------------------------------
  const tsxBin = path.join(dashboardDir, "node_modules/.bin/tsx");
  const [srvCmd, srvArgs] = fs.existsSync(tsxBin)
    ? [tsxBin, ["watch", "server/index.ts"]]
    : ["npx", ["tsx", "watch", "server/index.ts"]];
  server = spawn(srvCmd, srvArgs, {
    cwd: dashboardDir,
    env: {
      ...process.env,
      PORT: String(PORT),
      MOCK_VPS: "1",
      MOCK_SCENARIO: "sidebar-full",
      NOTES_DIR: path.join(mockDir, "notes"),
      AGENT_PROJECTS_DIR: path.join(mockDir, "projects"),
      PI_SESSIONS_DIR: path.join(mockDir, "sessions"),
      AGENT_SKILLS_DIR: path.join(mockDir, "skills"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (c) => process.env.SMOKE_VERBOSE && process.stdout.write(`[srv] ${c}`));
  server.stderr.on("data", (c) => process.env.SMOKE_VERBOSE && process.stderr.write(`[srv] ${c}`));
  server.on("exit", (code) => {
    server = null;
    if (code !== 0 && code !== null) console.error(`[srv] exited with ${code}`);
  });

  let ready = false;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${base}/api/projects`);
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  check("server boots", ready);

  // ---- HTTP routes ----------------------------------------------------------
  const projects = await getJSON("/api/projects");
  check("projects fixture", projects.projects.includes("alpha") && projects.projects.includes("beta"), JSON.stringify(projects));
  check("notes name", projects.notes === "notes");

  const agents = await getJSON("/api/agents");
  check("seeded agents (sidebar-full)", agents.agents.length >= 3, `got ${agents.agents.length}`);
  const seeded = agents.agents.find((a) => a.origin === "dashboard");
  check("dashboard-origin seed (lazy-attach path)", !!seeded);

  const sessions = await getJSON("/api/sessions?project=alpha");
  check("sessions fixture", sessions.sessions.length >= 1 && sessions.sessions[0].file.endsWith(".jsonl"));

  const models = await getJSON("/api/models");
  check("models fixture", models.models.length >= 3 && models.models.some((m) => m.id === "mock-sonnet") && models.models.some((m) => m.id === "mock-haiku"));

  const skills = await getJSON("/api/skills");
  check("skills fixture", skills.skills.length === 2);

  const tree = await getJSON("/api/notes/tree");
  check("notes tree", JSON.stringify(tree).includes("welcome.md"));

  const note = await getJSON("/api/notes/file?path=welcome.md");
  check("notes file", typeof note.content === "string" && note.content.includes("Mock"));

  const search = await getJSON("/api/notes/search?q=mock");
  check("notes search", search.results.length >= 1);

  const fd = new FormData();
  fd.append("file", new File(["hello mock"], "hi.txt", { type: "text/plain" }));
  const upRes = await fetch(`${base}/api/upload`, { method: "POST", body: fd });
  const up = await upRes.json();
  check("upload round-trip", upRes.ok && up.data === Buffer.from("hello mock").toString("base64"), JSON.stringify(up).slice(0, 120));

  const status = await getJSON("/api/git/status?project=beta");
  check("beta dirty tree", status.ok === true && status.dirty === true, JSON.stringify(status));

  const pull = await postJSON("/api/git/pull", { project: "notes" });
  check("notes pull works offline (local bare remote)", pull.ok === true, JSON.stringify(pull).slice(0, 160));

  const logs = await getJSON(`/api/agents/${seeded.id}/logs`);
  check("agent logs (FakePi stderr seed)", Array.isArray(logs.stderr) && logs.stderr.length >= 2, JSON.stringify(logs).slice(0, 160));

  // ---- events socket + agent lifecycle ---------------------------------------
  const ev = await wsConnect("/ws/events");
  const evSeen = [];
  ev.addEventListener("message", (e) => {
    try {
      evSeen.push(JSON.parse(String(e.data)));
    } catch {
      /* ignore */
    }
  });

  // Backfill + get_state against a seeded agent with preloaded history.
  const chat0 = await wsConnect(`/ws/agent/${seeded.id}`);
  const chat0Seen = [];
  chat0.addEventListener("message", (e) => {
    try {
      chat0Seen.push(JSON.parse(String(e.data)));
    } catch {
      /* ignore */
    }
  });
  const hello0 = await wsWait(chat0, (m) => m.type === "hello", 5_000, "hello");
  check("hello handshake", hello0.containerId === seeded.id);
  chat0.send(JSON.stringify({ type: "backfill", reqId: "s1" }));
  const bf = await wsWait(chat0, (m) => m.type === "backfill" && m.reqId === "s1", 5_000, "backfill");
  check("backfill returns entries", bf.success === true && bf.entries.length >= 2 && typeof bf.leafId === "string", JSON.stringify(bf).slice(0, 160));
  chat0.send(JSON.stringify({ type: "cmd", command: { type: "get_state", id: "s2" } }));
  const st = await wsWait(chat0, (m) => m.type === "response" && m.id === "s2", 5_000, "get_state");
  check(
    "get_state round-trip",
    st.success === true && st.data?.model?.provider === "openrouter" && typeof st.data?.sessionName === "string",
    JSON.stringify(st.data).slice(0, 160),
  );
  chat0.send(JSON.stringify({ type: "backfill", reqId: "s3", since: "no-such-id" }));
  const badCursor = await wsWait(chat0, (m) => m.type === "backfill" && m.reqId === "s3", 5_000, "unknown-cursor backfill");
  check("unknown cursor fails", badCursor.success === false, JSON.stringify(badCursor).slice(0, 120));
  // The real read-only extension stays silent at startup unless read-only is
  // on. This seed is not read-only, so its bridge must never observe a mode:
  // hello carries no readOnly flag, and no phantom "read-only mode is OFF"
  // notice arrives (the bridge would cache either and hello would leak it).
  check("hello omits unobserved readOnly", !("readOnly" in hello0), JSON.stringify(hello0).slice(0, 200));
  await sleep(700);
  check(
    "no phantom read-only OFF notice",
    !chat0Seen.some((m) => /read-only mode is off/i.test(String(m.event?.message ?? ""))),
    JSON.stringify(chat0Seen.map((m) => m.event?.message ?? m.type)).slice(0, 200),
  );
  chat0.close();

  // Spawn a fresh agent: events socket must push agents_changed start.
  const started = await postJSON("/api/agents/start", { project: "alpha", name: "smoke chat" });
  check("spawn returns id", typeof started.id === "string" && started.id.startsWith("mock-"));
  const freshId = started.id;
  await sleep(600);
  check("events: agents_changed start", evSeen.some((m) => m.type === "agents_changed" && m.action === "start" && m.id === freshId), JSON.stringify(evSeen).slice(0, 200));

  // ---- full chat flow on the fresh agent --------------------------------------
  const chat = await wsConnect(`/ws/agent/${freshId}`);
  await wsWait(chat, (m) => m.type === "hello", 5_000, "hello (fresh)");
  const seenTypes = [];
  const toolIds = new Set();
  chat.addEventListener("message", (e) => {
    try {
      const m = JSON.parse(String(e.data));
      if (m.type === "agent") seenTypes.push(m.event.type);
      if (m.type === "status") seenTypes.push(`status:${m.status}`);
      const evm = m.event;
      if (evm?.assistantMessageEvent?.id) toolIds.add(evm.assistantMessageEvent.id);
      if (evm?.toolCallId) toolIds.add(evm.toolCallId);
      const content = evm?.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) if (b?.type === "toolCall" && b.id) toolIds.add(b.id);
      }
    } catch {
      /* ignore */
    }
  });
  let seq = 0;
  const cmd = (c) => {
    const id = `u${++seq}`;
    chat.send(JSON.stringify({ type: "cmd", command: { ...c, id } }));
    return wsWait(chat, (m) => m.type === "response" && m.id === id, 10_000, `response ${c.type}`);
  };

  // NOTE: waiters for broadcasts that follow a command (settled, state
  // notices, read_only) are attached BEFORE sending: the bridge emits the
  // response and the broadcast back-to-back, and a late-attached listener
  // can miss the second frame entirely.
  const settledP = wsWait(chat, (m) => m.type === "agent" && m.event?.type === "agent_settled", 30_000, "agent_settled");
  const promptResp = await cmd({ type: "prompt", message: "hello mock" });
  check("prompt accepted", promptResp.success === true);
  await settledP;
  for (const t of ["agent_start", "message_start", "message_update", "tool_execution_start", "tool_execution_end", "message_end", "agent_settled"]) {
    check(`turn emits ${t}`, seenTypes.includes(t), seenTypes.slice(0, 12).join(","));
  }
  check("tool id t1 stable across call/execution/result", toolIds.size === 1 && toolIds.has("t1"), [...toolIds].join(","));

  const stateP = wsWait(
    chat,
    (m) => m.type === "state" && m.data?.model?.id === "mock-haiku",
    10_000,
    "set_model state notice",
  );
  const setModel = await cmd({ type: "set_model", provider: "openrouter", modelId: "mock-haiku" });
  check("set_model response", setModel.success === true && setModel.data?.id === "mock-haiku", JSON.stringify(setModel.data));
  const stateNotice = await stateP;
  check("set_model broadcasts state", !!stateNotice);

  const roOnP = wsWait(chat, (m) => m.type === "read_only" && m.value === true, 10_000, "read_only on");
  chat.send(JSON.stringify({ type: "cmd", command: { type: "prompt", message: "/read-only on", id: "ro1" } }));
  const roOn = await roOnP;
  check("read-only toggle on", !!roOn);
  const roOffP = wsWait(chat, (m) => m.type === "read_only" && m.value === false, 10_000, "read_only off");
  chat.send(JSON.stringify({ type: "cmd", command: { type: "prompt", message: "/read-only off", id: "ro2" } }));
  const roOff = await roOffP;
  check("read-only toggle off", !!roOff);
  chat.close();

  // ---- terminate ---------------------------------------------------------------
  await postJSON(`/api/agents/${freshId}/terminate`, {});
  await sleep(600);
  check("events: agents_changed die", evSeen.some((m) => m.type === "agents_changed" && m.action === "die" && m.id === freshId));
  check("events: agents_changed destroy", evSeen.some((m) => m.type === "agents_changed" && m.action === "destroy" && m.id === freshId));
  // Prod removes the container, so the list must drop it too (no ghost exited row).
  const agentsAfter = await getJSON("/api/agents");
  check("terminated agent drops from list", !agentsAfter.agents.some((a) => a.id === freshId));
  ev.close();

  console.log(`\nsmoke: all ${passed} checks passed`);
} catch (err) {
  console.error(`\n${err instanceof Error ? err.message : err}`);
  console.error(`smoke: FAILED after ${passed} passed checks`);
  killServer();
  process.exit(1);
}
killServer();
process.exit(0);
