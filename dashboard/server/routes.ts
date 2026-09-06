import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import { config, notesName, projectDir } from "./config.js";
import { containerState, listPiContainers, stopAndRemove, type AgentInfo } from "./docker.js";
import { startAgent } from "./jarvis.js";
import { gitCommitAllPush, gitCommitPush, gitPull, gitStatus } from "./git.js";
import { notesTree, readNote, searchNotes, writeNote } from "./notes.js";

const EDITABLE_EXT_SAFE = /\.(md|csv)$/i;
function safeRel(rel: string): boolean {
  const abs = path.resolve(config.notesDir, rel);
  const r = path.relative(config.notesDir, abs);
  return !r.startsWith("..") && !path.isAbsolute(r);
}
import { listSessions } from "./sessions.js";
import { listAllModels } from "./piModels.js";
import { listSkills } from "./skills.js";
import { bridges, ensureBridge } from "./bridge.js";

export const api = new Hono();

api.onError((err, c) => {
  console.error(`[api] ${c.req.method} ${c.req.path}:`, err);
  return c.json({ error: String(err instanceof Error ? err.message : err) }, 500);
});

// ---- projects -----------------------------------------------------------

api.get("/projects", async (c) => {
  let projects: string[] = [];
  try {
    const entries = await fs.promises.readdir(config.projectsDir, { withFileTypes: true });
    projects = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
  } catch {
    // projects dir not mounted/created yet
  }
  const notes = notesName();
  return c.json({ projects: projects.filter((p) => p !== notes), notes });
});

// ---- agents -------------------------------------------------------------

function decorate(a: AgentInfo): AgentInfo {
  const bridge = bridges.get(a.id);
  if (bridge) {
    a.live = bridge.status;
    a.sessionName = bridge.state.sessionName ?? a.sessionName;
    const m = bridge.state.model;
    if (m) a.model = `${m.provider}/${m.id}`;
    a.thinkingLevel = bridge.state.thinkingLevel ?? a.thinkingLevel;
  }
  return a;
}

api.get("/agents", async (c) => {
  const agents = await listPiContainers();
  for (const a of agents) {
    if (a.origin === "dashboard" && a.state === "running") {
      // Attach lazily so a restarted dashboard picks running agents back up.
      ensureBridge(a.id, a.project)
        .then(() => undefined)
        .catch(() => undefined);
    }
    decorate(a);
  }
  return c.json({ agents });
});

api.post("/agents/start", async (c) => {
  const body = (await c.req.json()) as {
    project?: string;
    sessionPath?: string;
    name?: string;
    readOnly?: boolean;
  };
  const project = body.project?.trim();
  if (!project) return c.json({ error: "project is required" }, 400);
  const dir = projectDir(project);
  if (!dir) return c.json({ error: `invalid project name: ${project}` }, 400);

  let sessionPath: string | undefined;
  if (body.sessionPath) {
    const abs = path.resolve(body.sessionPath);
    if (!abs.startsWith(config.sessionsDir + path.sep) || !abs.endsWith(".jsonl")) {
      return c.json({ error: "sessionPath must be a pi session file under the sessions dir" }, 400);
    }
    sessionPath = abs;
  }
  const name = body.name?.trim().slice(0, 200) || undefined;

  const containerId = await startAgent({ project: dir, sessionPath, name, readOnly: !!body.readOnly });
  // Pass the spawn name so the bridge can pin it: pi's auto-generated
  // session_info titles must never override a user-provided name.
  await ensureBridge(containerId, project, { explicitName: name }).catch(() => undefined);
  return c.json({ id: containerId, project });
});

api.post("/agents/:id/terminate", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { commit?: boolean };

  // "commit & push, then close": stage everything in the agent's project,
  // commit, push — only then stop the container.
  if (body.commit) {
    const summary = await listPiContainers();
    const agent = summary.find((a) => a.id === id);
    if (!agent) return c.json({ error: "agent not found" }, 404);
    const dir = projectDir(agent.project);
    if (!dir) return c.json({ error: "invalid project" }, 400);
    const result = await gitCommitAllPush(
      dir,
      `dashboard: commit before closing agent (${new Date().toISOString()})`,
    );
    if (!result.ok) return c.json({ error: "commit & push failed", output: result.output }, 409);
  }

  await stopAndRemove(id);
  bridges.get(id)?.destroy();
  return c.json({ ok: true });
});

api.get("/agents/:id/logs", (c) => {
  const bridge = bridges.get(c.req.param("id"));
  return c.json({ stderr: bridge?.stderrLines() ?? [] });
});

// ---- sessions (resume) --------------------------------------------------

api.get("/sessions", async (c) => {
  const project = c.req.query("project");
  if (!project) return c.json({ error: "project query param is required" }, 400);
  const dir = projectDir(project);
  if (!dir) return c.json({ error: `invalid project name: ${project}` }, 400);
  const sessions = await listSessions(dir);
  return c.json({ sessions });
});

// ---- models (picker "all" source) -----------------------------------------

api.get("/models", async (c) => {
  try {
    return c.json({ models: await listAllModels() });
  } catch (err) {
    return c.json({ error: String(err instanceof Error ? err.message : err) }, 502);
  }
});

// ---- skills (composer autocomplete) ----------------------------------------

api.get("/skills", async (c) => {
  return c.json({ skills: await listSkills() });
});

// ---- git ------------------------------------------------------------------

api.post("/git/pull", async (c) => {
  const body = (await c.req.json()) as { project?: string };
  const dir = projectDir(body.project ?? "");
  if (!dir) return c.json({ error: "invalid project" }, 400);
  const result = await gitPull(dir);
  return c.json(result, result.ok ? 200 : 409);
});

api.get("/git/status", async (c) => {
  const project = c.req.query("project");
  const dir = projectDir(project ?? "");
  if (!dir) return c.json({ error: "invalid project" }, 400);
  const status = await gitStatus(dir);
  return c.json(status, status.ok ? 200 : 409);
});

// ---- notes viewer --------------------------------------------------------

// ---- chat attachments -----------------------------------------------------

const UPLOAD_MAX_BYTES = 10 << 20; // 10 MiB per file

/** Stateless upload: validates the size cap server-side and hands the bytes
 *  (base64) back for embedding in the RPC `prompt` (images) or the message
 *  text (text-like files). Nothing is persisted. */
api.post("/upload", async (c) => {
  const declared = c.req.header("content-length");
  if (declared && Number(declared) > UPLOAD_MAX_BYTES * 1.34 + 4096) {
    return c.json({ error: `file too large (max ${Math.floor(UPLOAD_MAX_BYTES / (1 << 20))} MiB)` }, 413);
  }
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) {
    return c.json({ error: "multipart field 'file' is required" }, 400);
  }
  if (file.size > UPLOAD_MAX_BYTES) {
    return c.json({ error: `file too large (max ${Math.floor(UPLOAD_MAX_BYTES / (1 << 20))} MiB)` }, 413);
  }
  if (file.size === 0) {
    return c.json({ error: "empty file" }, 400);
  }
  const buf = Buffer.from(await file.arrayBuffer());
  const mimeType = file.type || "application/octet-stream";
  return c.json({
    name: file.name || "file",
    mimeType,
    size: file.size,
    image: mimeType.startsWith("image/"),
    data: buf.toString("base64"),
  });
});

api.get("/notes/tree", async (c) => {
  return c.json({ tree: await notesTree() });
});

api.get("/notes/file", async (c) => {
  const rel = c.req.query("path") ?? "";
  const file = await readNote(rel);
  if (!file) return c.json({ error: `not a readable note: ${rel}` }, 404);
  return c.json(file);
});

api.put("/notes/file", async (c) => {
  const body = (await c.req.json()) as { path?: string; content?: string };
  if (!body.path || typeof body.content !== "string") {
    return c.json({ error: "path and content are required" }, 400);
  }
  const mtime = await writeNote(body.path, body.content);
  if (mtime === null) return c.json({ error: `not a writable note: ${body.path}` }, 400);
  return c.json({ ok: true, mtime });
});

api.get("/notes/search", async (c) => {
  const q = c.req.query("q") ?? "";
  return c.json({ results: await searchNotes(q) });
});

api.post("/notes/commit", async (c) => {
  const body = (await c.req.json()) as { paths?: string[]; message?: string };
  const paths = (body.paths ?? []).filter((p) => typeof p === "string" && EDITABLE_EXT_SAFE.test(p) && safeRel(p));
  if (paths.length === 0) return c.json({ error: "no valid note paths given" }, 400);
  const message = (body.message ?? "").trim().slice(0, 300) || "notes update via dashboard";
  const result = await gitCommitPush(config.notesDir, paths, message);
  return c.json(result, result.ok ? 200 : 409);
});
