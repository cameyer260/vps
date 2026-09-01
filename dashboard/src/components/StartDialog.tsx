import { useEffect, useState } from "react";
import { api } from "../api";
import type { AgentInfo, SessionSummary } from "../types";

interface Props {
  initialProject: string | null;
  agents: AgentInfo[];
  onClose: () => void;
  onStarted: (agent: { id: string; project: string }) => void;
}

export function StartDialog({ initialProject, agents, onClose, onStarted }: Props) {
  const [projects, setProjects] = useState<string[]>([]);
  const [notesName, setNotesName] = useState("notes");
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [project, setProject] = useState<string>(initialProject ?? "");
  const [newProject, setNewProject] = useState("");
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [sessionPath, setSessionPath] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .projects()
      .then((r) => {
        setProjects(r.projects);
        setNotesName(r.notes);
        if (!initialProject) setProject(r.notes); // notes is the everyday default
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, [initialProject]);

  useEffect(() => {
    if (mode !== "existing" || !project) {
      setSessions(null);
      return;
    }
    setSessions(null);
    setSessionPath(null);
    api
      .sessions(project)
      .then((r) => setSessions(r.sessions))
      .catch(() => setSessions([]));
  }, [project, mode]);

  const effectiveProject = mode === "new" ? newProject.trim() : project;

  const start = async () => {
    if (!effectiveProject) {
      setError("pick or enter a project");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.startAgent({
        project: effectiveProject,
        ...(sessionPath ? { sessionPath } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      onStarted(res);
    } catch (e) {
      setError(String((e as Error).message ?? e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Start agent</h2>

        <label className="field-label">Project</label>
        {mode === "existing" ? (
          <select
            value={project}
            onChange={(e) => setProject(e.target.value)}
            className="select"
          >
            <option value={notesName}>📝 {notesName} (pinned)</option>
            {projects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="input"
            autoFocus
            placeholder="new-project-name"
            value={newProject}
            onChange={(e) => setNewProject(e.target.value)}
          />
        )}
        <button className="link" onClick={() => setMode(mode === "new" ? "existing" : "new")}>
          {mode === "existing" ? "+ new project…" : "← pick an existing project"}
        </button>

        <label className="field-label">Conversation</label>
        {mode === "existing" && project ? (
          <div className="session-list">
            <label className={`session-row${sessionPath === null ? " selected" : ""}`}>
              <input
                type="radio"
                checked={sessionPath === null}
                onChange={() => setSessionPath(null)}
              />
              <span>new conversation</span>
            </label>
            {sessions === null && <div className="dim pad">loading sessions…</div>}
            {sessions?.map((s) => (
              <label key={s.file} className={`session-row${sessionPath === s.file ? " selected" : ""}`}>
                <input
                  type="radio"
                  checked={sessionPath === s.file}
                  onChange={() => setSessionPath(s.file)}
                />
                <span className="session-info">
                  <span className="session-title">{s.name ?? s.preview ?? "session " + s.id.slice(0, 8)}</span>
                  {s.preview && <span className="session-preview">{s.preview}</span>}
                  <span className="session-date">
                    {s.timestamp ? new Date(s.timestamp).toLocaleString() : ""}
                  </span>
                </span>
              </label>
            ))}
            {sessions?.length === 0 && <div className="dim pad">no past sessions</div>}
          </div>
        ) : (
          <div className="dim pad">
            {mode === "new"
              ? "a fresh conversation; the project is created for you (mkdir + git init)"
              : "pick an existing project to list its conversations"}
          </div>
        )}

        <label className="field-label">Session name (optional)</label>
        <input
          className="input"
          placeholder="e.g. refactor auth"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        {error && <div className="error-box">{error}</div>}

        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            cancel
          </button>
          <button className="btn primary" onClick={start} disabled={busy || !effectiveProject}>
            {busy ? "starting…" : "start"}
          </button>
        </div>
      </div>
    </div>
  );
}
