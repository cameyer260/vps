import { useState } from "react";
import { api } from "../api";
import { CopyButton } from "./CopyButton";

interface Props {
  notesName: string;
  onStarted: (agent: { id: string; project: string }) => void;
  label?: string;
  className?: string;
}

/**
 * One-click "new conversation" for the notes project: host-side git pull
 * first (failures surfaced with copy-to-clipboard), then a notes agent with
 * full tools (read-only is opt-in via the start dialog).
 */
export function StartNotesButton({ notesName, onStarted, label = "+ new conversation", className }: Props) {
  const [busy, setBusy] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    try {
      const res = await api.startAgent({
        project: notesName,
        name: `notes ${new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`,
      });
      onStarted(res);
    } catch (e) {
      setPullError(`start failed: ${String((e as Error).message ?? e)}`);
      setBusy(false);
    }
  };

  const click = async () => {
    setBusy(true);
    setPullError(null);
    try {
      const pull = await api.gitPull(notesName);
      if (!pull.ok) {
        setPullError(pull.output);
        setBusy(false);
        return;
      }
    } catch (e) {
      setPullError(String((e as Error).message ?? e));
      setBusy(false);
      return;
    }
    void start();
  };

  return (
    <>
      <button className={className ?? "btn small primary"} onClick={click} disabled={busy}>
        {busy ? "starting…" : label}
      </button>
      {pullError && (
        <div className="modal-scrim" onClick={() => setPullError(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>git pull failed</h2>
            <pre className="porcelain">{pullError}</pre>
            <p className="dim">
              The pull runs host-side before every notes-agent start. Fix the error, or
              start the agent anyway — or copy this and hand it to an agent.
            </p>
            <div className="modal-actions">
              <CopyButton text={pullError} />
              <span style={{ flex: 1 }} />
              <button className="btn" onClick={() => setPullError(null)}>
                cancel
              </button>
              <button className="btn primary" onClick={start}>
                start anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
