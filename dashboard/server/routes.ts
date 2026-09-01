import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import { config, notesName, projectDir } from "./config.js";
import { containerState, listPiContainers, stopAndRemove, type AgentInfo } from "./docker.js";
import { startAgent } from "./jarvis.js";
import { gitCommitAllPush, gitPull, gitStatus } from "./git.js";
import { listSessions } from "./sessions.js";
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
    a.model = bridge.state.model ?? a.model;
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
  await ensureBridge(containerId, project).catch(() => undefined);
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
