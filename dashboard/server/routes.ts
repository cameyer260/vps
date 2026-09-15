import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import { config, notesName, projectDir, resolveHostDir } from "./config.js";
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
import { readScopePatterns } from "./modelScope.js";
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
    directory?: string;
    runtime?: string;
    sessionPath?: string;
    name?: string;
    readOnly?: boolean;
    generalChat?: boolean;
  };
  const runtime = body.runtime === "host" ? "host" : "jarvis";
  const generalChat = !!body.generalChat;

  // Bare-metal host agents (docs/host-pi.md): cwd anywhere under /home/dev,
  // no read-only extension, no General Chat. Whitelist enforced here and
  // again in the supervisor.
  if (runtime === "host") {
    if (generalChat) return c.json({ error: "generalChat is not supported for host agents" }, 400);
    if (!body.directory?.trim()) return c.json({ error: "directory is required for host agents" }, 400);
    const dir = await resolveHostDir(body.directory);
    if (!dir) return c.json({ error: `invalid directory (must exist under ${config.homeDir}): ${body.directory}` }, 400);
    let sessionPath: string | undefined;
    if (body.sessionPath) {
      const abs = path.resolve(body.sessionPath);
      if (!abs.startsWith(config.sessionsDir + path.sep) || !abs.endsWith(".jsonl")) {
        return c.json({ error: "sessionPath must be a pi session file under the sessions dir" }, 400);
      }
      sessionPath = abs;
    }
    const name = body.name?.trim().slice(0, 200) || undefined;
    const project = path.basename(dir);
    let id: string;
    try {
      id = await getRuntime().spawn({ project: dir, sessionPath, name, readOnly: false, generalChat: false, runtime: "host" });
    } catch (err) {
      return c.json({ error: String(err instanceof Error ? err.message : err) }, 502);
    }
    await ensureBridge(id, project, { explicitName: name }).catch(() => undefined);
    return c.json({ id, project, directory: dir, runtime: "host", generalChat: false });
  }

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

  const containerId = await getRuntime().spawn({ project: dir, sessionPath, name, readOnly, generalChat, runtime: "jarvis" });
  // Pass the spawn name so the bridge can pin it: pi's auto-generated
  // session_info titles must never override a user-provided name.
  await ensureBridge(containerId, project, { explicitName: name }).catch(() => undefined);
  return c.json({ id: containerId, project, runtime: "jarvis", generalChat });
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
  // Host mode passes an absolute directory instead of a project name
  // (docs/host-pi.md); same session store, same cwd matching.
  const directory = c.req.query("directory");
  if (directory) {
    const dir = await resolveHostDir(directory);
    if (!dir) return c.json({ error: `invalid directory: ${directory}` }, 400);
    const sessions = await listSessions(dir);
    return c.json({ sessions, directory: dir, project: path.basename(dir) });
  }
  const project = c.req.query("project");
  if (!project) return c.json({ error: "project query param is required" }, 400);
  const dir = projectDir(project);
  if (!dir) return c.json({ error: `invalid project name: ${project}` }, 400);
  const sessions = await listSessions(dir);
  return c.json({ sessions });
});

// ---- host directory validation (New Agent modal green/red dot) -----------

api.get("/host-validate", async (c) => {
  const input = c.req.query("path") ?? "";
  const dir = await resolveHostDir(input);
  if (!dir) return c.json({ ok: false as const, error: `not a directory under ${config.homeDir}` });
  return c.json({ ok: true as const, directory: dir, project: path.basename(dir) });
});

// ---- model scope (picker "scoped" tab) --------------------------------------
// The `enabledModels` patterns from pi's global settings file — the same
// source pi resolves session scope from. Matched against the available list
// client-side. Null when no scope is configured (picker shows one list).
api.get("/models/scope", async (c) => {
  return c.json({ patterns: readScopePatterns() });
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

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const MIME_TO_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
};
const EXT_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

/** Chat image uploads: persisted to the screenshots inbox (same dir the
 *  Mac screenshot tool scps to, same host path inside every jarvis agent)
 *  and the prompt carries the saved absolute path — the model reads the
 *  pixels with the Read tool, exactly like a pasted Mac screenshot path.
 *  Images only: anything else is rejected (415). Pruning is the
 *  host systemd timer's job (tools/prune-screenshots.*). */
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
  const origName = file.name || "file";
  // Server-side image truth: MIME first, safe image extension as fallback
  // (pastes can arrive with an empty MIME but a real image name).
  // Anything else is rejected — this endpoint is images-only.
  if (!mimeType.startsWith("image/") && !IMAGE_EXT_RE.test(origName)) {
    return c.json({ error: `unsupported file (images only): ${origName}` }, 415);
  }
    const extMatch = origName.match(IMAGE_EXT_RE);
    const ext = (extMatch ? `.${extMatch[1]!.toLowerCase().replace(/^jpeg$/, "jpg")}` : MIME_TO_EXT[mimeType]) ?? ".png";
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const rand = Math.random().toString(36).slice(2, 8);
    const saved = `chat-${stamp}-${rand}${ext}`;
    await fs.promises.mkdir(config.screenshotsDir, { recursive: true });
    const abs = path.join(config.screenshotsDir, saved);
    await fs.promises.writeFile(abs, buf);
    return c.json({
      name: origName,
      mimeType: mimeType.startsWith("image/") ? mimeType : EXT_TO_MIME[ext]!,
      size: file.size,
      image: true,
      path: abs,
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
