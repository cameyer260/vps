import { useState } from "react";
import { api, ApiError } from "../api";
import type { AgentInfo } from "../types";
import { CopyButton } from "./CopyButton";

interface Props {
  agent: AgentInfo;
  small?: boolean;
  onTerminated: () => void;
}

/**
 * Terminate (stop + remove). Any dirty working tree warns first with
 * "stop anyway" / "back to chat" — the dashboard never commits on the user's
 * behalf; commit & push is the agent's job when asked in the chat. Agents
 * may leave uncommitted work behind and the git policy is
 * use-at-your-own-risk.
 */
export function TerminateButton({ agent, small, onTerminated }: Props) {
  const [stage, setStage] = useState<"confirm" | "dirty" | "error" | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = async () => {
    setBusy(true);
    try {
      const status = await api.gitStatus(agent.project);
      if (status.dirty) {
        setStage("dirty");
        setBusy(false);
        return;
      }
    } catch {
      // status unavailable (not a repo?) — fall through to plain confirm
    }
    setStage("confirm");
    setBusy(false);
  };

  const terminate = async () => {
    setBusy(true);
    try {
      await api.terminateAgent(agent.id);
      setStage(null);
      onTerminated();
    } catch (e) {
      // 409 = removal already in progress (docker stop/remove race): the
      // container is going away, so treat it as success instead of
      // flashing a phantom "Stop failed" after a good kill.
      if (e instanceof ApiError && e.status === 409) {
        setStage(null);
        onTerminated();
        return;
      }
      setErrorMessage(String((e as Error).message ?? e));
      setStage("error");
      setBusy(false);
    }
  };

  const close = () => {
    setStage(null);
    setErrorMessage(null);
  };

  return (
    <>
      <button
        className={`btn ghost stop-agent${small ? " small" : ""}`}
        title="Stop agent — shuts down and removes the container"
        aria-label="Stop agent"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          void open();
        }}
      >
        <svg
          className="power-icon"
          viewBox="0 0 24 24"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M12 3v8" />
          <path d="M6.3 6.5a8 8 0 1 0 11.4 0" />
        </svg>
      </button>

      {stage === "confirm" && (
        <div className="modal-scrim" onClick={close}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Stop agent?</h2>
            <p className="dim">
              Stops the container and removes it. The conversation stays in pi's session
              store and can be resumed later.
            </p>
            <div className="modal-actions">
              <button className="btn" onClick={close}>
                cancel
              </button>
              <button className="btn danger" disabled={busy} onClick={() => void terminate()}>
                {busy ? "stopping…" : "stop agent"}
              </button>
            </div>
          </div>
        </div>
      )}

      {stage === "dirty" && (
        <div className="modal-scrim" onClick={close}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>You have uncommitted changes in {agent.project}</h2>
            <div className="modal-actions center">
              <button className="btn" onClick={close}>
                back to chat
              </button>
              <button className="btn danger" disabled={busy} onClick={() => void terminate()}>
                {busy ? "stopping…" : "stop anyway"}
              </button>
            </div>
          </div>
        </div>
      )}

      {stage === "error" && errorMessage && (
        <div className="modal-scrim" onClick={close}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Stop failed</h2>
            <pre className="porcelain">{errorMessage}</pre>
            <div className="modal-actions">
              <CopyButton text={errorMessage} />
              <span style={{ flex: 1 }} />
              <button className="btn" onClick={close}>
                close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
