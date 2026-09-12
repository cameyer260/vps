import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import { config, notesName, projectDir } from "./config.js";
import type { AgentInfo } from "./docker.js";
import { getRuntime } from "./runtime.js";
import { gitCommitPush, gitStatus } from "./git.js";
import {
  filterCommitPaths,
  projectTree,
  readProjectFile,
  searchProject,
  writeProjectFile,
} from "./files.js";
import { listSessions } from "./sessions.js";
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
  const agents = await getRuntime().list();
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
    generalChat?: boolean;
  };
  const generalChat = !!body.generalChat;
  // GC spawns are always notes-dir agents: force the project even when the
  // caller sends another (or none). Non-GC spawns still require a project.
  const project = generalChat ? notesName() : body.project?.trim();
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
  // GC starts read-only/on by default (spec §6); an explicit `readOnly:
  // false` opts out. Project agents keep today's default-off semantics.
  const readOnly = generalChat ? body.readOnly !== false : !!body.readOnly;

  const containerId = await getRuntime().spawn({ project: dir, sessionPath, name, readOnly, generalChat });
  // Pass the spawn name so the bridge can pin it: pi's auto-generated
  // session_info titles must never override a user-provided name.
  await ensureBridge(containerId, project, { explicitName: name }).catch(() => undefined);
  return c.json({ id: containerId, project, generalChat });
});

api.post("/agents/:id/terminate", async (c) => {
  const id = c.req.param("id");
  // Plain stop + remove. Uncommitted work is the user's call: the UI warns
  // on a dirty tree and they direct the agent to commit & push in the chat —
  // the dashboard never commits on their behalf.
  await getRuntime().stopAndRemove(id);
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
  // Full catalog via the runtime seam: jarvis models in prod, the
  // deterministic fixture in mock. The MOCK_VPS + production guard lives in
  // getRuntime(), so no env branch is needed here.
  try {
    return c.json({ models: await getRuntime().listModels() });
  } catch (err) {
    return c.json({ error: String(err instanceof Error ? err.message : err) }, 502);
  }
});

// ---- skills (composer autocomplete) ----------------------------------------

api.get("/skills", async (c) => {
  return c.json({ skills: await listSkills() });
});

// ---- git ------------------------------------------------------------------

api.get("/git/status", async (c) => {
  const project = c.req.query("project");
  const dir = projectDir(project ?? "");
  if (!dir) return c.json({ error: "invalid project" }, 400);
  const status = await gitStatus(dir);
  return c.json(status, status.ok ? 200 : 409);
});

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

// ---- project-scoped files (IDE backend) ------------------------------------
// Same traversal guards throughout, generalized to any project
// from `GET /api/projects`. Binary files are refused with a `binary: true`
// signal (the UI shows "not shown"); oversize with 413.

api.get("/files/tree", async (c) => {
  const project = c.req.query("project") ?? "";
  const tree = await projectTree(project);
  if (!tree) return c.json({ error: `invalid project: ${project}` }, 400);
  return c.json({ tree, project });
});

api.get("/files/file", async (c) => {
  const project = c.req.query("project") ?? "";
  const rel = c.req.query("path") ?? "";
  if (!projectDir(project)) return c.json({ error: `invalid project: ${project}` }, 400);
  const r = await readProjectFile(project, rel);
  if (!r.ok) {
    if (r.reason === "binary") {
      return c.json({ error: `binary file not shown: ${rel}`, binary: true, kind: "binary" }, 415);
    }
    if (r.reason === "oversize") {
      return c.json({ error: `file too large (max 2 MiB): ${rel}`, oversize: true, size: r.size }, 413);
    }
    if (r.reason === "invalid") return c.json({ error: `invalid path: ${rel}` }, 400);
    return c.json({ error: `not a readable file: ${rel}` }, 404);
  }
  return c.json(r.file);
});

api.put("/files/file", async (c) => {
  const body = (await c.req.json()) as { project?: string; path?: string; content?: string };
  const project = body.project ?? "";
  if (!projectDir(project)) return c.json({ error: `invalid project: ${project}` }, 400);
  if (!body.path || typeof body.content !== "string") {
    return c.json({ error: "project, path and content are required" }, 400);
  }
  const r = await writeProjectFile(project, body.path, body.content);
  if (!r.ok) {
    if (r.reason === "binary") {
      return c.json({ error: `binary file not shown: ${body.path}`, binary: true }, 415);
    }
    if (r.reason === "oversize") return c.json({ error: "file too large (max 2 MiB)" }, 413);
    return c.json({ error: `not a writable file: ${body.path}` }, 400);
  }
  return c.json({ ok: true, mtime: r.mtime });
});

api.get("/files/search", async (c) => {
  const project = c.req.query("project") ?? "";
  const q = c.req.query("q") ?? "";
  const results = await searchProject(project, q);
  if (!results) return c.json({ error: `invalid project: ${project}` }, 400);
  return c.json({ results });
});

api.post("/files/commit", async (c) => {
  const body = (await c.req.json()) as { project?: string; paths?: string[]; message?: string };
  const project = body.project ?? "";
  const dir = projectDir(project);
  if (!dir) return c.json({ error: `invalid project: ${project}` }, 400);
  const paths = filterCommitPaths(project, body.paths);
  if (paths.length === 0) return c.json({ error: "no valid file paths given" }, 400);
  const message = (body.message ?? "").trim().slice(0, 300) || "dashboard update";
  const result = await gitCommitPush(dir, paths, message);
  return c.json(result, result.ok ? 200 : 409);
});
