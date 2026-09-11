interface Props {
  /** true = read-only ON (green), false = OFF / full tools (red). */
  value: boolean;
  onToggle: () => void;
  disabled?: boolean;
  title?: string;
}

/**
 * Shared read-only toggle (spec §7.3): the agent harness extension switch
 * used by the New Agent modal and the GC sub-header (and the agent chat
 * header). Green when on, red when off (Apple palette, sketch 2).
 *
 * Stateless on purpose: ground truth is the agent — the extension notifies
 * on every mode change, the bridge relays those and hands its last known
 * state to new clients in `hello` (see chat.ts). No localStorage: per-device
 * memory goes stale.
 */
export function ReadOnlyToggle({ value, onToggle, disabled, title }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      className={`ro-toggle${value ? " on" : " off"}`}
      onClick={onToggle}
      disabled={disabled}
      title={
        title ??
        "Read-only mode: edit/write tools disabled and mutating bash commands blocked (/read-only on|off)"
      }
    >
      read-only {value ? "on" : "off"}
    </button>
  );
}
