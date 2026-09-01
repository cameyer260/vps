import { useState } from "react";
import { api } from "../api";
import type { AgentInfo } from "../types";
import { CopyButton } from "./CopyButton";

interface Props {
  agent: AgentInfo;
  notesName: string;
  small?: boolean;
  onTerminated: () => void;
}

/**
 * Terminate (stop + remove). For notes agents, a dirty working tree first
 * warns with "close anyway" / "commit & push, then close" — agents may leave
 * uncommitted work behind and the git policy is use-at-your-own-risk.
 */
export function TerminateButton({ agent, notesName, small, onTerminated }: Props) {
  const [stage, setStage] = useState<"confirm" | "dirty" | "commitError" | null>(null);
  const [porcelain, setPorcelain] = useState("");
  const [commitError, setCommitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = async () => {
    setBusy(true);
    if (agent.project === notesName) {
      try {
        const status = await api.gitStatus(notesName);
        if (status.dirty) {
          setPorcelain(status.porcelain);
          setStage("dirty");
          setBusy(false);
          return;
        }
      } catch {
        // status unavailable (not a repo?) — fall through to plain confirm
      }
    }
    setStage("confirm");
    setBusy(false);
  };

  const terminate = async (commitFirst: boolean) => {
    setBusy(true);
    try {
      await api.terminateAgent(agent.id, commitFirst);
      onTerminated();
    } catch (e) {
      setCommitError(String((e as Error).message ?? e));
      setStage("commitError");
      setBusy(false);
    }
  };

  const close = () => {
    setStage(null);
    setCommitError(null);
  };

  return (
    <>
      <button
        className={`btn ghost danger${small ? " small" : ""}`}
        title="Terminate agent"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          void open();
        }}
      >
        ✕
      </button>

      {stage === "confirm" && (
        <div className="modal-scrim" onClick={close}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Terminate agent?</h2>
            <p className="dim">
              Stops the container and removes it. The conversation stays in pi's session
              store and can be resumed later.
            </p>
            <div className="modal-actions">
              <button className="btn" onClick={close}>
                cancel
              </button>
              <button className="btn danger" disabled={busy} onClick={() => terminate(false)}>
                {busy ? "terminating…" : "terminate"}
              </button>
            </div>
          </div>
        </div>
      )}

      {stage === "dirty" && (
        <div className="modal-scrim" onClick={close}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Uncommitted changes in {agent.project}</h2>
            <pre className="porcelain">{porcelain}</pre>
            <p className="dim">Close anyway, or commit &amp; push everything before closing?</p>
            <div className="modal-actions">
              <CopyButton text={porcelain} label="copy status" />
              <span style={{ flex: 1 }} />
              <button className="btn" onClick={close}>
                cancel
              </button>
              <button className="btn" disabled={busy} onClick={() => terminate(false)}>
                close anyway
              </button>
              <button
                className="btn primary"
                disabled={busy}
                onClick={() => terminate(true)}
                title="git add -A, commit, push, then stop the agent"
              >
                {busy ? "committing…" : "commit & push, then close"}
              </button>
            </div>
          </div>
        </div>
      )}

      {stage === "commitError" && commitError && (
        <div className="modal-scrim" onClick={close}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Commit &amp; push failed</h2>
            <pre className="porcelain">{commitError}</pre>
            <p className="dim">Fix it (e.g. hand the error to an agent) or close anyway.</p>
            <div className="modal-actions">
              <CopyButton text={commitError} />
              <span style={{ flex: 1 }} />
              <button className="btn" onClick={close}>
                cancel
              </button>
              <button className="btn danger" disabled={busy} onClick={() => terminate(false)}>
                close anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
