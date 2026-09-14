import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { SessionSummary } from "../types";
import { ReadOnlyToggle } from "./ReadOnlyToggle";
import { ModalScrim } from "./Modal";
import { TreeModal, type TreeModalItem } from "./TreeModal";

interface Props {
  initialProject: string | null;
  notesName: string;
  onClose: () => void;
  onStarted: (agent: { id: string; project: string }) => void;
}

/**
 * New Agent modal: Jarvis containers by default, bare-metal host pi with the
 * Jarvis toggle off (docs/host-pi.md). Jarvis mode keeps the project picker
 * (+ new-project autocreate), read-only toggle, and conversation picker;
 * host mode swaps the project picker for a /home/dev-relative directory
 * input with instant valid/invalid dot, hides read-only (no extension on
 * the host), and keeps the conversation picker (same session store,
 * matched by cwd).
 */
export function StartDialog({ initialProject, notesName, onClose, onStarted }: Props) {
  const [projects, setProjects] = useState<string[]>([]);
  const [mode, setMode] = useState<"existing" | "new">("existing");
  // Jarvis toggle: on (green) = container via `jarvis rpc` (default);
  // off (red) = bare-metal host pi with full dev permissions.
  const [jarvis, setJarvis] = useState(true);
  // No pre-selection: the conversation gate warning needs a no-project
  // state, and the picker is one tap away. An opener-passed project still
  // pre-fills (kept for callers that deep-link with one).
  const [project, setProject] = useState<string>(initialProject ?? "");
  const [newProject, setNewProject] = useState("");
  // Host-mode directory, relative to /home/dev (the "/home/dev/" prefix
  // is fixed UI, never typed) + instant validation (green/red dot).
  const [relDir, setRelDir] = useState("");
  const [dirValid, setDirValid] = useState<boolean | null>(null);
  const [dirNormalized, setDirNormalized] = useState<string | null>(null);
  const [dirProject, setDirProject] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [sessionPath, setSessionPath] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState(false); // off default: full tools
  const [picker, setPicker] = useState<"project" | "conversation" | null>(null);
  const [gateWarning, setGateWarning] = useState<string | null>(null);
  const gateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The project gate warning is a transient toast popup, not a persistent
  // embedded warning (Group F feedback): it floats over the modal and
  // dismisses itself without shifting the layout.
  const flashGateWarning = (msg: string) => {
    setGateWarning(msg);
    if (gateTimer.current) clearTimeout(gateTimer.current);
    gateTimer.current = setTimeout(() => setGateWarning(null), 3500);
  };
  const clearGateWarning = () => {
    if (gateTimer.current) {
      clearTimeout(gateTimer.current);
      gateTimer.current = null;
    }
    setGateWarning(null);
  };
  useEffect(
    () => () => {
      if (gateTimer.current) clearTimeout(gateTimer.current);
    },
    [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .projects()
      .then((r) => setProjects(r.projects))
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  // Instant directory validation for host mode (debounced): green dot when
  // the path exists under /home/dev, red otherwise. The input holds just
  // the part after "/home/dev/" — join it here (tolerating a pasted
  // absolute path or leading slashes) so the server keeps validating an
  // absolute dir and the spawn path is unchanged.
  useEffect(() => {
    if (jarvis) return;
    const rel = relDir.trim().replace(/^\/+/, "").replace(/^home\/dev\//, "");
    if (!rel) {
      setDirValid(null);
      setDirNormalized(null);
      setDirProject(null);
      return;
    }
    const value = `/home/dev/${rel}`;
    setDirValid(null);
    const t = setTimeout(() => {
      api
        .validateHostDir(value)
        .then((r) => {
          if (r.ok) {
            setDirValid(true);
            setDirNormalized(r.directory);
            setDirProject(r.project);
          } else {
            setDirValid(false);
            setDirNormalized(null);
            setDirProject(null);
          }
        })
        .catch(() => {
          setDirValid(false);
          setDirNormalized(null);
          setDirProject(null);
        });
    }, 250);
    return () => clearTimeout(t);
  }, [relDir, jarvis]);

  useEffect(() => {
    if (!jarvis) {
      if (!dirValid || !dirNormalized) {
        setSessions(null);
        return;
      }
      setSessions(null);
      setSessionPath(null);
      api
        .sessionsByDir(dirNormalized)
        .then((r) => setSessions(r.sessions))
        .catch(() => setSessions([]));
      return;
    }
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
  }, [project, mode, jarvis, dirValid, dirNormalized]);

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

  /** Gate: the conversation list does not open until a project/dir is picked. */
  const openConversationPicker = () => {
    if (!jarvis) {
      if (!dirValid || !dirNormalized) {
        flashGateWarning("Enter a valid directory first — conversations live under a directory.");
        return;
      }
      clearGateWarning();
      setPicker("conversation");
      return;
    }
    if (mode === "new" || !project) {
      flashGateWarning(
        mode === "new"
          ? "A new project starts a fresh conversation — nothing to pick yet."
          : "Pick a project first — conversations live under a project.",
      );
      return;
    }
    clearGateWarning();
    setPicker("conversation");
  };

  const start = async () => {
    if (!jarvis) {
      if (!dirValid || !dirNormalized) {
        setError("enter a valid directory under /home/dev");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const res = await api.startAgent({
          runtime: "host",
          directory: dirNormalized,
          ...(sessionPath ? { sessionPath } : {}),
        });
        onStarted(res);
      } catch (e) {
        setError(String((e as Error).message ?? e));
        setBusy(false);
      }
      return;
    }
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
    <ModalScrim onClose={onClose}>
      <div
        className="modal start-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="New Agent"
      >
        <div className="start-head-row">
          <h2>New Agent</h2>
          <button
            type="button"
            role="switch"
            aria-checked={jarvis}
            className={`ro-toggle${jarvis ? " on" : " off"}`}
            onClick={() => {
              setJarvis(!jarvis);
              clearGateWarning();
              setError(null);
            }}
            title="Jarvis: container-isolated pi (on) vs bare-metal host pi with full dev permissions (off). See docs/host-pi.md."
          >
            jarvis {jarvis ? "on" : "off"}
          </button>
        </div>

        {!jarvis ? (
          <>
            <div className="start-label-row">
              <label className="field-label" htmlFor="start-directory">
                Directory
              </label>
              <span className="dim start-label-note">from /home/dev</span>
            </div>
            <div className="host-dir-row">
              <span className="host-prefix" aria-hidden="true">
                /home/dev/
              </span>
              <input
                id="start-directory"
                className="input host-dir-input"
                value={relDir}
                onChange={(e) => setRelDir(e.target.value)}
                aria-label="Host directory, relative to /home/dev"
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
              />
              <span
                className={`host-dot${dirValid === true ? " ok" : dirValid === false ? " bad" : ""}`}
                aria-hidden="true"
                title={
                  dirValid === true
                    ? "valid directory"
                    : dirValid === false
                      ? "not a directory under /home/dev"
                      : "enter a path"
                }
              />
            </div>
            {dirValid === true && dirNormalized ? (
              <div className="dim pad">
                {dirProject} — {dirNormalized}
              </div>
            ) : dirValid === false && relDir.trim() !== "" ? (
              <div className="dim pad">not a directory under /home/dev</div>
            ) : null}
            <div className="dim pad host-warn">
              Runs on the host with full dev permissions — no container isolation.
            </div>
          </>
        ) : (
          <>
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
                clearGateWarning();
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
            </div>
          </>
        )}

        <label className="field-label">Conversation</label>
        {!jarvis || mode === "new" ? (
          !jarvis ? (
            <button type="button" className="picker-field" onClick={openConversationPicker}>
              <span>{selectedSession ? sessionTitle(selectedSession) : "New conversation"}</span>
              <span className="picker-chevron" aria-hidden="true">
                ▾
              </span>
            </button>
          ) : (
            <div className="dim pad">New conversation</div>
          )
        ) : (
          <button type="button" className="picker-field" onClick={openConversationPicker}>
            <span>{selectedSession ? sessionTitle(selectedSession) : "New conversation"}</span>
            <span className="picker-chevron" aria-hidden="true">
              ▾
            </span>
          </button>
        )}
        {gateWarning && (
          <div className="gate-toast" role="status">
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
            disabled={busy || (jarvis ? !effectiveProject : !dirValid || !dirNormalized)}
          >
            {busy ? "starting…" : "Start"}
          </button>
        </div>
      </div>

      {picker === "project" && jarvis && (
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
              clearGateWarning();
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
    </ModalScrim>
  );
}
