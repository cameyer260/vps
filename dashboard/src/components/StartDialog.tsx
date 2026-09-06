import { useEffect, useState } from "react";
import { api } from "../api";
import type { SessionSummary } from "../types";
import { CopyButton } from "./CopyButton";

interface Props {
  initialProject: string | null;
  notesName: string;
  onClose: () => void;
  onStarted: (agent: { id: string; project: string }) => void;
}

export function StartDialog({ initialProject, notesName, onClose, onStarted }: Props) {
  const [projects, setProjects] = useState<string[]>([]);
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [project, setProject] = useState<string>(initialProject ?? notesName);
  const [newProject, setNewProject] = useState("");
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [sessionPath, setSessionPath] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [readOnly, setReadOnly] = useState(false); // default off: full tools; flip for a chat-only session
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);
  const [pullOk, setPullOk] = useState(false);

  const isNotes = mode === "existing" && project === notesName;

  useEffect(() => {
    api
      .projects()
      .then((r) => setProjects(r.projects))
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

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

  const start = async (skipPull: boolean) => {
    if (!effectiveProject) {
      setError("pick or enter a project");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Every notes-agent start does a host-side git pull first; failures are
      // surfaced (copy-to-clipboard for handing to an agent) and can be
      // overridden with "start anyway".
      if (effectiveProject === notesName && !skipPull && !pullOk) {
        const pull = await api.gitPull(notesName);
        if (!pull.ok) {
          setPullError(pull.output || "git pull failed");
          setBusy(false);
          return;
        }
        setPullOk(true);
      }
      const res = await api.startAgent({
        project: effectiveProject,
        ...(sessionPath ? { sessionPath } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
        readOnly: isNotes ? readOnly : false,
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
            onChange={(e) => {
              setProject(e.target.value);
              setPullOk(false);
              setPullError(null);
            }}
            className="select"
          >
            <option value={notesName}>{notesName} (pinned)</option>
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
        <button
          className="link"
          onClick={() => {
            setMode(mode === "new" ? "existing" : "new");
            setPullOk(false);
            setPullError(null);
          }}
        >
          {mode === "existing" ? "+ new project…" : "↩ pick an existing project"}
        </button>

        {isNotes && (
          <>
            <label className="field-label">Mode</label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={readOnly}
                onChange={(e) => setReadOnly(e.target.checked)}
              />
              <span>
                start read-only{" "}
                <span className="dim">(chat-only session; edit/write disabled — toggle in chat any time)</span>
              </span>
            </label>
          </>
        )}

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
                  <span className="session-title">
                    {s.name ?? s.preview ?? "session " + s.id.slice(0, 8)}
                  </span>
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

        {pullError && (
          <div className="error-box">
            <div className="error-head">
              <span>git pull failed (host-side, before every notes-agent start)</span>
              <CopyButton text={pullError} />
            </div>
            <pre className="porcelain">{pullError}</pre>
          </div>
        )}
        {error && <div className="error-box">{error}</div>}

        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            cancel
          </button>
          {pullError && (
            <button className="btn" onClick={onClose} title="close and fix the error first">
              fix first
            </button>
          )}
          <button
            className="btn primary"
            onClick={() => start(!!pullError)}
            disabled={busy || !effectiveProject}
          >
            {busy ? "starting…" : pullError ? "start anyway" : "start"}
          </button>
        </div>
      </div>
    </div>
  );
}
