#!/usr/bin/env node
/**
 * pi-host-supervisor — own bare-metal `pi --mode rpc` agents for the dashboard.
 *
 * Long-running systemd user service (see `tools/pi-host-supervisor.service`
 * and `docs/host-pi.md`). The dashboard container talks to it over a Unix
 * socket because it cannot spawn host processes itself; the supervisor is the
 * parent of every host pi child, so host agents die with it and are never
 * orphaned (dashboard redeploys — which only restart the client — kill none).
 *
 * Protocol: newline-delimited JSON, one request line per connection.
 * Unary ops reply with one JSON line and close:
 *   {"op":"ping"} → {"ok":true,...}
 *   {"op":"list"} → {"ok":true,"agents":[{id,directory,project,pid,startedAt,state}]}
 *   {"op":"spawn","cwd":"/home/dev/...","sessionPath":"/abs/...jsonl"|undefined,"name":string|undefined}
 *     → {"ok":true,"id","pid","directory","project","startedAt"} (validates whitelist;
 *       an immediately-failing child returns {"ok":false} — never a ghost id)
 *   {"op":"kill","id":"host-..."} → {"ok":true} (idempotent; SIGTERM → SIGKILL, deletes entry)
 *   {"op":"logs","id":"host-..."} → {"ok":true,"stderr":[...last 200 lines]}
 * Streaming ops keep the connection open after the {"ok":true} reply:
 *   {"op":"attach","id":"host-..."} — client bytes → pi stdin; pi stdout → client.
 *     Multiple attach connections fan out (each gets a full copy of stdout).
 *   {"op":"subscribe"} — server pushes {"action":"start|die|destroy","id":...} lines.
 *
 * Whitelist (mirrors dashboard `resolveHostDir`): cwd must exist, be a
 * directory, and realpath inside the dev home dir. sessionPath must sit under
 * the pi sessions dir and end in .jsonl. No shell — argv spawn only.
 *
 * Env:
 *   PI_HOST_SUPERVISOR_SOCK — socket path (default /run/user/1000/pi-host-supervisor.sock)
 *   HOME_DIR / HOME — whitelist root (default /home/dev)
 *   PI_SESSIONS_DIR — sessionPath root (default /home/dev/.pi/agent/sessions)
 *   PI_BIN — pi binary (default "pi"). NOTE: plain "pi" is NOT on the
 *   systemd unit's PATH (nvm), so the unit pins the absolute nvm path —
 *   without it every spawn fails async with ENOENT (see doSpawn gate).
 *   PI_HOST_STATE_DIR — pidfile dir (default ~/.local/state/pi-host-supervisor)
 *
 * Node builtins only.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const SOCK =
  process.env.PI_HOST_SUPERVISOR_SOCK ?? "/run/user/1000/pi-host-supervisor.sock";
const HOME_ROOT = process.env.HOME_DIR ?? process.env.HOME ?? "/home/dev";
const SESSIONS_DIR =
  process.env.PI_SESSIONS_DIR ?? "/home/dev/.pi/agent/sessions";
const PI_BIN = process.env.PI_BIN ?? "pi";
const STATE_DIR =
  process.env.PI_HOST_STATE_DIR ??
  path.join(os.homedir(), ".local/state/pi-host-supervisor");

const HOST_CONTEXT =
  "You are a bare-metal pi agent running directly on the operator's VPS (Ubuntu 24.04, user dev) with full dev permissions — no container isolation. Your working directory is your task area and deliverable; prefer acting inside it. Leaving it can affect the host (other checkouts, credentials, services), so report back instead when a task seems to require it. Models are accessed via the OpenRouter provider.";

const log = (...a) => console.error("[pi-host-supervisor]", ...a);

/** @type {Map<string, any>} */
const agents = new Map();
let seq = 0;
/** @type {Set<net.Socket>} */
const subscribers = new Set();

function emit(action, id) {
  const line = JSON.stringify({ action, id }) + "\n";
  for (const s of [...subscribers]) {
    try {
      s.write(line);
    } catch {
      subscribers.delete(s);
    }
  }
}

async function realpathSafe(p) {
  try {
    return await fs.promises.realpath(p);
  } catch {
    return null;
  }
}

async function validateCwd(input) {
  const trimmed = (input ?? "").trim();
  if (!trimmed || !path.isAbsolute(trimmed)) return null;
  const real = await realpathSafe(path.resolve(trimmed));
  if (!real) return null;
  try {
    const st = await fs.promises.stat(real);
    if (!st.isDirectory()) return null;
  } catch {
    return null;
  }
  const homeReal = (await realpathSafe(HOME_ROOT)) ?? path.resolve(HOME_ROOT);
  if (real !== homeReal && !real.startsWith(homeReal + path.sep)) return null;
  return real;
}

function validateSessionPath(input) {
  if (input === undefined || input === null || input === "") return undefined;
  if (typeof input !== "string") return null;
  const abs = path.resolve(input);
  if (!abs.startsWith(SESSIONS_DIR + path.sep) || !abs.endsWith(".jsonl")) return null;
  return abs;
}

function newId() {
  seq += 1;
  return `host-${Date.now().toString(36)}-${seq.toString(36)}`;
}

function pidfile(id) {
  return path.join(STATE_DIR, `${id}.pid`);
}

async function writePidfile(id, pid) {
  try {
    await fs.promises.mkdir(STATE_DIR, { recursive: true });
    await fs.promises.writeFile(pidfile(id), String(pid), "utf8");
  } catch (err) {
    log(`pidfile write failed for ${id}:`, String(err?.message ?? err));
  }
}

async function removePidfile(id) {
  try {
    await fs.promises.unlink(pidfile(id));
  } catch {
    /* already gone */
  }
}

function pushStderr(agent, chunk) {
  const text = chunk.toString("utf8");
  for (const line of text.split("\n")) {
    if (line.trim()) {
      agent.stderrTail.push(line);
      if (agent.stderrTail.length > 200) {
        agent.stderrTail.splice(0, agent.stderrTail.length - 200);
      }
    }
  }
}

async function doSpawn(req) {
  const directory = await validateCwd(req.cwd);
  if (!directory) {
    return { ok: false, error: `invalid directory (must exist under ${HOME_ROOT}): ${req.cwd ?? ""}` };
  }
  const sessionPath = validateSessionPath(req.sessionPath);
  if (sessionPath === null) {
    return { ok: false, error: "sessionPath must be a pi session file under the sessions dir" };
  }
  const name = typeof req.name === "string" ? req.name.trim().slice(0, 200) || undefined : undefined;
  const id = newId();
  const args = [PI_BIN, "--mode", "rpc", "-a"];
  if (sessionPath) args.push("--session", sessionPath);
  if (name) args.push("-n", name);
  args.push("--append-system-prompt", HOST_CONTEXT);
  // Run pi under THIS node (process.execPath), not the PATH-resolved one:
  // PI_BIN's shebang is `#!/usr/bin/env node`, and systemd's default PATH
  // only has the system node (v18) — pi 0.85+ needs fs.globSync (node 22+)
  // and dies instantly otherwise. The supervisor itself always runs on a
  // new-enough node, so its own binary is the correct runtime for pi too.
  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd: directory,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    return { ok: false, error: `spawn failed: ${String(err?.message ?? err)}` };
  }
  // Gate on the child actually starting: if pi dies instantly (bad node,
  // missing binary, crashing flags), 'error'/'close' fire before any client
  // attaches. Registering the agent anyway is what stranded dashboards on
  // "no response for prompt" — fail the RPC instead so the UI shows the
  // error immediately and no ghost agent lingers.
  const spawnErr = await new Promise((resolve) => {
    child.once("spawn", () => resolve(null));
    child.once("error", resolve);
  });
  if (spawnErr) {
    return { ok: false, error: `spawn failed (${PI_BIN}): ${String(spawnErr?.message ?? spawnErr)}` };
  }
  const agent = {
    id,
    directory,
    project: path.basename(directory),
    pid: child.pid ?? -1,
    child,
    startedAt: new Date().toISOString(),
    state: "running",
    stderrTail: [],
    attach: new Set(),
  };
  agents.set(id, agent);
  await writePidfile(id, agent.pid);
  child.on("error", (err) => {
    pushStderr(agent, Buffer.from(`[supervisor] spawn error: ${String(err?.message ?? err)}\n`));
    agent.state = "exited";
    emit("die", id);
    for (const s of [...agent.attach]) {
      try {
        s.end();
      } catch {
        /* ignore */
      }
    }
    agent.attach.clear();
  });
  child.stdout.on("data", (chunk) => {
    for (const s of [...agent.attach]) {
      try {
        s.write(chunk);
      } catch {
        agent.attach.delete(s);
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    pushStderr(agent, chunk);
  });
  // Writes to a dying pi's stdin surface as EPIPE 'error' events on the
  // pipe — without a listener those become uncaughtExceptions.
  child.stdin?.on("error", (err) => {
    pushStderr(agent, Buffer.from(`[supervisor] stdin error: ${String(err?.message ?? err)}\n`));
  });
  child.on("close", () => {
    if (agent.state === "running") {
      agent.state = "exited";
      emit("die", id);
    }
    void removePidfile(id);
    for (const s of [...agent.attach]) {
      try {
        s.end();
      } catch {
        /* ignore */
      }
    }
    agent.attach.clear();
  });
  emit("start", id);
  log(`spawn ${id} pid=${agent.pid} cwd=${directory}`);
  return { ok: true, id, pid: agent.pid, directory, project: agent.project, startedAt: agent.startedAt };
}

async function doKill(id) {
  const agent = agents.get(id);
  if (!agent) return { ok: true, gone: true };
  const child = agent.child;
  try {
    child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  const exited = await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), 10_000);
    timer.unref?.();
    child.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!exited) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
  agents.delete(id);
  await removePidfile(id);
  for (const s of [...agent.attach]) {
    try {
      s.end();
    } catch {
      /* ignore */
    }
  }
  agent.attach.clear();
  emit("die", id);
  emit("destroy", id);
  log(`kill ${id}`);
  return { ok: true };
}

function listAgents() {
  return [...agents.values()].map((a) => ({
    id: a.id,
    directory: a.directory,
    project: a.project,
    pid: a.pid,
    startedAt: a.startedAt,
    state: a.state,
  }));
}

function handleConn(socket) {
  let buf = "";
  let mode = "request"; // request | attach-proxy | subscribed
  /** @type {any|null} */
  let attached = null;

  const reply = (obj, close = true) => {
    try {
      socket.write(JSON.stringify(obj) + "\n", () => {
        if (close) {
          try {
            socket.end();
          } catch {
            /* ignore */
          }
        }
      });
    } catch {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }
  };

  socket.on("data", (chunk) => {
    if (mode === "attach-proxy" && attached) {
      try {
        attached.child.stdin.write(chunk);
      } catch {
        /* pi gone — close() below tears us down */
      }
      return;
    }
    if (mode === "subscribed") return; // subscribers never send more
    buf += chunk.toString("utf8");
    const idx = buf.indexOf("\n");
    if (idx === -1) {
      if (buf.length > 64 * 1024) {
        reply({ ok: false, error: "request too large" });
        buf = "";
      }
      return;
    }
    const line = buf.slice(0, idx).replace(/\r$/, "");
    buf = buf.slice(idx + 1);
    if (!line.trim()) return;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      reply({ ok: false, error: "invalid JSON" });
      return;
    }
    void handleRequest(req);
  });

  socket.on("close", () => {
    subscribers.delete(socket);
    if (attached) {
      attached.attach.delete(socket);
      attached = null;
    }
  });
  socket.on("error", () => {
    subscribers.delete(socket);
    if (attached) {
      attached.attach.delete(socket);
      attached = null;
    }
  });

  async function handleRequest(req) {
    const op = req?.op;
    if (op === "ping") {
      reply({ ok: true, pid: process.pid, agents: agents.size });
      return;
    }
    if (op === "list") {
      reply({ ok: true, agents: listAgents() });
      return;
    }
    if (op === "spawn") {
      const res = await doSpawn(req);
      reply(res);
      return;
    }
    if (op === "kill") {
      if (typeof req.id !== "string") {
        reply({ ok: false, error: "id is required" });
        return;
      }
      reply(await doKill(req.id));
      return;
    }
    if (op === "logs") {
      const agent = typeof req.id === "string" ? agents.get(req.id) : undefined;
      if (!agent) {
        reply({ ok: false, error: `unknown agent: ${req.id ?? ""}` });
        return;
      }
      reply({ ok: true, stderr: [...agent.stderrTail] });
      return;
    }
    if (op === "subscribe") {
      reply({ ok: true }, false);
      mode = "subscribed";
      subscribers.add(socket);
      return;
    }
    if (op === "attach") {
      const agent = typeof req.id === "string" ? agents.get(req.id) : undefined;
      if (!agent) {
        reply({ ok: false, error: `unknown agent: ${req.id ?? ""}` });
        return;
      }
      if (agent.state !== "running") {
        reply({ ok: false, error: "agent is not running" });
        return;
      }
      reply({ ok: true }, false);
      mode = "attach-proxy";
      attached = agent;
      agent.attach.add(socket);
      return;
    }
    reply({ ok: false, error: `unknown op: ${String(op)}` });
  }
}

async function sweepStalePidfiles() {
  let files = [];
  try {
    files = await fs.promises.readdir(STATE_DIR);
  } catch {
    return;
  }
  for (const f of files) {
    if (!f.endsWith(".pid")) continue;
    const full = path.join(STATE_DIR, f);
    let pid = -1;
    try {
      pid = Number((await fs.promises.readFile(full, "utf8")).trim());
    } catch {
      /* unreadable — drop it */
    }
    if (Number.isInteger(pid) && pid > 1) {
      try {
        process.kill(pid, "SIGTERM");
        log(`sweep: SIGTERM stale pid ${pid} (${f})`);
      } catch {
        /* already gone */
      }
    }
    try {
      await fs.promises.unlink(full);
    } catch {
      /* ignore */
    }
  }
}

async function cleanupAndExit(signal) {
  log(`received ${signal} — stopping ${agents.size} host agent(s)`);
  const kills = [...agents.keys()].map((id) => doKill(id).catch(() => ({ ok: false })));
  await Promise.all(kills);
  try {
    server.close();
  } catch {
    /* ignore */
  }
  try {
    await fs.promises.unlink(SOCK);
  } catch {
    /* ignore */
  }
  process.exit(0);
}

const server = net.createServer(handleConn);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => void cleanupAndExit(sig));
}
process.on("uncaughtException", (err) => log("uncaughtException", err));

// A stale socket file from a crash blocks listen: probe it first — a live
// supervisor answers ping, a stale file refuses, and only then unlink.
async function isLiveSocket(p) {
  return new Promise((resolve) => {
    const s = net.createConnection({ path: p });
    const done = (v) => {
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    s.on("connect", () => {
      s.write(JSON.stringify({ op: "ping" }) + "\n");
    });
    s.on("data", () => done(true));
    s.on("error", () => done(false));
    setTimeout(() => done(false), 1000).unref?.();
  });
}

await sweepStalePidfiles();
// Fail visibly, not mysteriously: PI_BIN must resolve here (the systemd
// unit pins the absolute nvm path — plain "pi" is NOT on its PATH).
try {
  await fs.promises.access(PI_BIN, fs.constants.X_OK);
} catch {
  log(`WARNING: PI_BIN=${PI_BIN} is not executable — host spawns will fail (set PI_BIN to the absolute pi path; see docs/host-pi.md)`);
}
try {
  const st = await fs.promises.stat(SOCK).catch(() => null);
  if (st) {
    if (await isLiveSocket(SOCK)) {
      log(`another supervisor is live on ${SOCK} — exiting`);
      process.exit(1);
    }
    await fs.promises.unlink(SOCK);
    log("removed stale socket file");
  }
} catch (err) {
  log("socket pre-check failed:", String(err?.message ?? err));
}
await fs.promises.mkdir(path.dirname(SOCK), { recursive: true }).catch(() => {});
server.listen(SOCK, () => log(`listening on ${SOCK} (pid ${process.pid}, node ${process.version}, PI_BIN=${PI_BIN})`));
server.on("error", (err) => {
  log("server error:", String(err?.message ?? err));
  process.exit(1);
});
