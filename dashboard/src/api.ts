import type { AgentInfo, PiModel, SessionSummary, SkillInfo, TreeNode } from "./types";

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok && body?.error) throw new Error(body.error);
  if (!res.ok) throw new Error(`request failed (${res.status})`);
  return body;
}

export const api = {
  agents: () => fetch("/api/agents").then((r) => json<{ agents: AgentInfo[] }>(r)),
  projects: () =>
    fetch("/api/projects").then((r) => json<{ projects: string[]; notes: string }>(r)),
  sessions: (project: string) =>
    fetch(`/api/sessions?project=${encodeURIComponent(project)}`).then((r) =>
      json<{ sessions: SessionSummary[] }>(r),
    ),
  allModels: () => fetch("/api/models").then((r) => json<{ models: PiModel[] }>(r)),
  skills: () => fetch("/api/skills").then((r) => json<{ skills: SkillInfo[] }>(r)),
  startAgent: (body: {
    project: string;
    sessionPath?: string;
    name?: string;
    readOnly?: boolean;
  }) =>
    fetch("/api/agents/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => json<{ id: string; project: string }>(r)),
  terminateAgent: (id: string, commitFirst = false) =>
    fetch(`/api/agents/${id}/terminate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commit: commitFirst }),
    }).then((r) => json<{ ok: boolean }>(r)),
  gitPull: (project: string) =>
    fetch("/api/git/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project }),
    }).then((r) => json<{ ok: boolean; output: string }>(r)),
  gitStatus: (project: string) =>
    fetch(`/api/git/status?project=${encodeURIComponent(project)}`).then((r) =>
      json<{ ok: boolean; dirty: boolean; porcelain: string; branch: string | null }>(r),
    ),
  notesTree: () =>
    fetch("/api/notes/tree").then((r) => json<{ tree: TreeNode[] }>(r)),
  notesFile: (path: string) =>
    fetch(`/api/notes/file?path=${encodeURIComponent(path)}`).then((r) =>
      json<{ path: string; content: string; mtime: number; size: number }>(r),
    ),
  notesWrite: (path: string, content: string) =>
    fetch("/api/notes/file", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, content }),
    }).then((r) => json<{ ok: boolean; mtime: number }>(r)),
  notesSearch: (q: string) =>
    fetch(`/api/notes/search?q=${encodeURIComponent(q)}`).then((r) =>
      json<{ results: { path: string; line: number; text: string }[] }>(r),
    ),
  notesCommit: (paths: string[], message: string) =>
    fetch("/api/notes/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths, message }),
    }).then((r) => json<{ ok: boolean; output: string }>(r)),
};
