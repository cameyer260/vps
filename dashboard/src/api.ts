import type { AgentInfo, PiModel, SessionSummary, SkillInfo, TreeNode, UploadedFile } from "./types";

/** Error with the full API response body attached — callers that need more
 *  than the message (e.g. the git output in a 409) read `body`. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(String(body["error"] ?? `request failed (${status})`));
    this.status = status;
    this.body = body;
  }
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, body as Record<string, unknown>);
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
  upload: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return fetch("/api/upload", { method: "POST", body: fd }).then((r) => json<UploadedFile>(r));
  },
  startAgent: (body: {
    project: string;
    sessionPath?: string;
    name?: string;
    readOnly?: boolean;
    generalChat?: boolean;
  }) =>
    fetch("/api/agents/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => json<{ id: string; project: string }>(r)),
  terminateAgent: (id: string) =>
    fetch(`/api/agents/${id}/terminate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }).then((r) => json<{ ok: boolean }>(r)),
  gitStatus: (project: string) =>
    fetch(`/api/git/status?project=${encodeURIComponent(project)}`).then((r) =>
      json<{ ok: boolean; dirty: boolean; porcelain: string; branch: string | null }>(r),
    ),
  filesTree: (project: string) =>
    fetch(`/api/files/tree?project=${encodeURIComponent(project)}`).then((r) =>
      json<{ tree: TreeNode[]; project: string }>(r),
    ),
  filesFile: (project: string, path: string) =>
    fetch(
      `/api/files/file?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`,
    ).then((r) =>
      json<{ path: string; content: string; mtime: number; size: number; kind: string }>(r),
    ),
  filesWrite: (project: string, path: string, content: string) =>
    fetch("/api/files/file", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project, path, content }),
    }).then((r) => json<{ ok: boolean; mtime: number }>(r)),
  filesSearch: (project: string, q: string) =>
    fetch(
      `/api/files/search?project=${encodeURIComponent(project)}&q=${encodeURIComponent(q)}`,
    ).then((r) => json<{ results: { path: string; line: number; text: string }[] }>(r)),
  filesCommit: (project: string, paths: string[], message: string) =>
    fetch("/api/files/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project, paths, message }),
    }).then((r) => json<{ ok: boolean; output: string }>(r)),
};
