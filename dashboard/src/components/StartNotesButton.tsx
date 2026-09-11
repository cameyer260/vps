import { useState } from "react";
import { api } from "../api";

interface Props {
  notesName: string;
  onStarted: (agent: { id: string; project: string }) => void;
  label?: string;
  className?: string;
}

/**
 * One-click "new conversation" for the notes project: a notes agent with
 * full tools (read-only is opt-in via the start dialog).
 */
export function StartNotesButton({ notesName, onStarted, label = "+ new conversation", className }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const click = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.startAgent({
        project: notesName,
        name: `notes ${new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`,
      });
      onStarted(res);
    } catch (e) {
      setError(`start failed: ${String((e as Error).message ?? e)}`);
      setBusy(false);
    }
  };

  return (
    <>
      <button className={className ?? "btn small primary"} onClick={click} disabled={busy}>
        {busy ? "starting…" : label}
      </button>
      {error && (
        <div className="modal-scrim" onClick={() => setError(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>couldn't start agent</h2>
            <pre className="porcelain">{error}</pre>
            <div className="modal-actions">
              <span style={{ flex: 1 }} />
              <button className="btn" onClick={() => setError(null)}>
                close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
