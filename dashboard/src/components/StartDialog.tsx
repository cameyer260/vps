import { useEffect, useState } from "react";
import { api } from "../api";
import type { SessionSummary } from "../types";
import { ReadOnlyToggle } from "./ReadOnlyToggle";
import { TreeModal, type TreeModalItem } from "./TreeModal";

interface Props {
  initialProject: string | null;
  notesName: string;
  onClose: () => void;
  onStarted: (agent: { id: string; project: string }) => void;
}

/**
 * New Agent modal (spec §4): fields top-to-bottom per the sketch —
 * expand-downward project picker (notes + projects, plus a new-project name
 * option fed to the backend autocreate), `ReadOnlyToggle` (off by default),
 * expand-downward conversation select (`New conversation` first row, gated on a
 * project being picked), and a green Start / red Exit footer. Start launches
 * via the existing `jarvis rpc` path and opens the new chat; Exit dismisses
 * with no side effects. Picker lists reuse the shared `TreeModal` shell.
 */
export function StartDialog({ initialProject, notesName, onClose, onStarted }: Props) {
  const [projects, setProjects] = useState<string[]>([]);
  const [mode, setMode] = useState<"existing" | "new">("existing");
  // No pre-selection: the conversation gate warning needs a no-project
  // state, and the picker is one tap away. An opener-passed project still
  // pre-fills (kept for callers that deep-link with one).
  const [project, setProject] = useState<string>(initialProject ?? "");
  const [newProject, setNewProject] = useState("");
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [sessionPath, setSessionPath] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState(false); // off default: full tools
  const [picker, setPicker] = useState<"project" | "conversation" | null>(null);
  const [gateWarning, setGateWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const sessionTitle = (s: SessionSummary): string =>
    s.name ?? s.preview ?? "session " + s.id.slice(0, 8);

  const selectedSession = sessions?.find((s) => s.file === sessionPath) ?? null;

  const projectItems: TreeModalItem[] = [
    { key: "__new__", title: "+ New project…" },
    { key: notesName, title: `${notesName} (notes)` },
    ...projects
      .filter((p) => p !== notesName)
      .map((p) => ({ key: p, title: p })),
  ];

  const convoItems: TreeModalItem[] = [
    { key: "__new__", title: "New conversation", subtitle: "start a fresh conversation" },
    ...(sessions ?? []).map((s) => ({
      key: s.file,
      title: sessionTitle(s),
      // Subtitle is the timestamp only — the preview repeats the title
      // (feedback: drop the lower repetition and the "—").
      subtitle: s.timestamp ? new Date(s.timestamp).toLocaleString() : undefined,
    })),
  ];

  /** Gate: the conversation list does not open until a project is picked. */
  const openConversationPicker = () => {
    if (mode === "new" || !project) {
      setGateWarning(
        mode === "new"
          ? "A new project starts a fresh conversation — nothing to pick yet."
          : "Pick a project first — conversations live under a project.",
      );
      return;
    }
    setGateWarning(null);
    setPicker("conversation");
  };

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
        ...(mode === "existing" && sessionPath ? { sessionPath } : {}),
        // The start route accepts readOnly for any project — send it for
        // all, not just notes (phase 3 fix).
        readOnly,
      });
      onStarted(res);
    } catch (e) {
      setError(String((e as Error).message ?? e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="modal start-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="New Agent"
      >
        <h2>New Agent</h2>

        <label className="field-label" id="start-project-label">
          Project
        </label>
        {mode === "existing" ? (
          <button
            type="button"
            className="picker-field"
            aria-labelledby="start-project-label"
            onClick={() => setPicker("project")}
          >
            <span className={project ? undefined : "dim"}>{project || "Select project…"}</span>
            <span className="picker-chevron" aria-hidden="true">
              ▾
            </span>
          </button>
        ) : (
          <input
            className="input"
            autoFocus
            placeholder="new-project-name"
            value={newProject}
            onChange={(e) => setNewProject(e.target.value)}
            aria-label="New project name"
          />
        )}
        <button
          type="button"
          className="link"
          onClick={() => {
            setMode(mode === "new" ? "existing" : "new");
            setGateWarning(null);
          }}
        >
          {mode === "existing" ? "+ new project…" : "↩ pick an existing project"}
        </button>
        {mode === "new" && (
          <div className="dim pad">
            a fresh conversation; the project is created for you (mkdir + git init)
          </div>
        )}

        <label className="field-label">Read-only</label>
        <div className="check-row">
          <ReadOnlyToggle value={readOnly} onToggle={() => setReadOnly(!readOnly)} />
          <span>
            start read-only{" "}
            <span className="dim">(full tools when off — toggle in chat any time)</span>
          </span>
        </div>

        <label className="field-label">Conversation</label>
        {mode === "new" ? (
          <div className="dim pad">New conversation</div>
        ) : (
          <button type="button" className="picker-field" onClick={openConversationPicker}>
            <span>{selectedSession ? sessionTitle(selectedSession) : "New conversation"}</span>
            <span className="picker-chevron" aria-hidden="true">
              ▾
            </span>
          </button>
        )}
        {gateWarning && (
          <div className="gate-warning" role="alert">
            {gateWarning}
          </div>
        )}

        {error && <div className="error-box">{error}</div>}

        <div className="modal-actions start-actions">
          <button type="button" className="btn danger" onClick={onClose} disabled={busy}>
            Exit
          </button>
          <button
            type="button"
            className="btn go"
            onClick={() => void start()}
            disabled={busy || !effectiveProject}
          >
            {busy ? "starting…" : "Start"}
          </button>
        </div>
      </div>

      {picker === "project" && (
        <TreeModal
          title="Select project"
          items={projectItems}
          emptyText="no projects yet — create one below"
          onClose={() => setPicker(null)}
          onSelect={(item) => {
            if (item.key === "__new__") {
              setMode("new");
            } else {
              setMode("existing");
              setProject(item.key);
              setGateWarning(null);
            }
            setPicker(null);
          }}
        />
      )}

      {picker === "conversation" && (
        <TreeModal
          title="Conversations"
          items={convoItems}
          emptyText="no past sessions"
          footer={sessions === null ? <span className="dim">loading sessions…</span> : undefined}
          onClose={() => setPicker(null)}
          onSelect={(item) => {
            setSessionPath(item.key === "__new__" ? null : item.key);
            setPicker(null);
          }}
        />
      )}
    </div>
  );
}
