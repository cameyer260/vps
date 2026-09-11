import { useEffect, useRef, useState, type UIEvent } from "react";
import { api } from "../api";

/**
 * Plain monospace code/text pane (spec §5.2): every other text file (code,
 * JSON, Dockerfile, configs…) renders as monospace + line numbers. No
 * syntax highlighting in v1. Editing is gated by the IDE EditToggle
 * (default read-only): read-only renders a <pre>, editing a <textarea>;
 * saves debounce to PUT /api/files/file like the other editors. Keyed by
 * project+path in the parent (one instance per open file).
 */
export function CodePane({
  project,
  path,
  content,
  onChange,
  onSaved,
  editing = true,
}: {
  project: string;
  path: string;
  content: string;
  onChange: (content: string) => void;
  onSaved?: (content: string) => void;
  editing?: boolean;
}) {
  const [draft, setDraft] = useState(content);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(content);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const gutterRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const edit = (next: string) => {
    setDraft(next);
    latest.current = next;
    onChangeRef.current(next);
    setStatus("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const text = latest.current;
      api
        .filesWrite(project, path, text)
        .then(() => {
          setStatus("saved");
          onSavedRef.current?.(text);
        })
        .catch(() => setStatus("error"));
    }, 600);
  };

  // Gutter and text share font/line-height/padding-top so numbers stay
  // aligned; long lines scroll horizontally (no wrap) on both sides. A
  // trailing newline is not a line (vim agrees) — no phantom number.
  const lines = draft.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const gutter = lines.map((_, i) => i + 1).join("\n");

  const syncScroll = (e: UIEvent<HTMLTextAreaElement>) => {
    if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
  };

  return (
    <div className="code-pane">
      <div className="code-scroll">
        <div className="code-gutter" ref={gutterRef} aria-hidden="true">
          <pre>{gutter}</pre>
        </div>
        {editing ? (
          <textarea
            className="code-area"
            value={draft}
            wrap="off"
            spellCheck={false}
            aria-label={path}
            onChange={(e) => edit(e.target.value)}
            onScroll={syncScroll}
          />
        ) : (
          <pre className="code-read">{draft}</pre>
        )}
      </div>
      <div className="raw-status dim">
        {status === "saving" && "saving…"}
        {status === "saved" && "saved ✓"}
        {status === "error" && "save failed"}
      </div>
    </div>
  );
}
