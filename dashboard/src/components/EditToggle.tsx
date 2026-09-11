interface Props {
  /** true = editing enabled, false = read-only (default). */
  editing: boolean;
  onChange: (editing: boolean) => void;
  disabled?: boolean;
  title?: string;
}

/**
 * IDE edit toggle (spec §7.4): a frontend-only pencil in the IDE sub-header.
 * Default read-only — tapping lines does nothing until toggled on (autosave
 * + session-scoped commit as today). No harness extension involved, unlike
 * ReadOnlyToggle — it only gates the viewer editing affordance.
 */
export function EditToggle({ editing, onChange, disabled, title }: Props) {
  return (
    <button
      type="button"
      className={`edit-toggle${editing ? " on" : ""}`}
      aria-pressed={editing}
      aria-label={editing ? "Switch to read-only" : "Enable editing"}
      title={title ?? (editing ? "Editing on — tap to lock read-only" : "Read-only — tap to enable editing")}
      disabled={disabled}
      onClick={() => onChange(!editing)}
    >
      <svg
        viewBox="0 0 24 24"
        width="15"
        height="15"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
      </svg>
    </button>
  );
}
