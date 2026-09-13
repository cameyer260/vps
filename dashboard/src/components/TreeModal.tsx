import { useEffect, useState, type ReactNode } from "react";
import { ModalScrim } from "./Modal";

export interface TreeModalItem {
  key: string;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Presence of children makes the row expandable (tap toggles). */
  children?: TreeModalItem[];
  defaultExpanded?: boolean;
  /** Greyed-out row (git-ignored files in the IDE tree, VS Code style). */
  dimmed?: boolean;
}

export interface TreeModalSearch {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

interface Props {
  title: string;
  items: TreeModalItem[];
  /** Fired when a leaf row (no children) is tapped. Parents expand instead. */
  onSelect: (item: TreeModalItem) => void;
  onClose: () => void;
  /** Optional search input rendered above the list; filtering stays with the caller. */
  search?: TreeModalSearch;
  emptyText?: string;
  /** `center` (default dialog) or `left` (slides/overlays from the left edge). */
  variant?: "center" | "left";
  footer?: ReactNode;
}

/**
 * Shared expandable scrollable list-modal (spec §7.2): the single shell
 * behind the project picker, file tree, file search results, and GC
 * conversation list. Variants differ only in data source + row action +
 * header (search input where needed) — all of which are props here.
 *
 * Phase 2 wires it minimally (present but unexposed): later phases mount it
 * behind the existing entry points (StartDialog pickers, IDE tree/search,
 * GC conversations).
 */
export function TreeModal({
  title,
  items,
  onSelect,
  onClose,
  search,
  emptyText = "nothing here",
  variant = "center",
  footer,
}: Props) {
  const left = variant === "left";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      // The search may still hold focus when the modal unmounts (e.g.
      // tap-a-row selects while the keyboard is up) — always drop the
      // pill-hiding flag so the nav can't stick hidden.
      document.documentElement.classList.remove("modal-typing");
    };
  }, [onClose]);

  return (
    <ModalScrim onClose={onClose} className={left ? "tree-modal-scrim-left" : undefined}>
      <div
        className={`modal tree-modal${left ? " tree-modal-left" : ""}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="tree-modal-head">
          <h2>{title}</h2>
          <button className="btn ghost tree-modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {search && (
          <div className="tree-modal-search">
            <input
              className="input"
              placeholder={search.placeholder ?? "filter…"}
              value={search.value}
              onChange={(e) => search.onChange(e.target.value)}
              // No autoFocus: the keyboard must only appear when the user
              // taps the input. Auto-focusing pans the iOS layout viewport
              // and leaves the modal swipeable mid-screen. While focused
              // (keyboard up) the floating bottom pill hides so the modal
              // never overlaps it — same pattern as chat-typing.
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              enterKeyHint="search"
              inputMode="search"
              onFocus={() => document.documentElement.classList.add("modal-typing")}
              onBlur={() => document.documentElement.classList.remove("modal-typing")}
            />
          </div>
        )}
        <div className="tree-modal-list">
          {items.length === 0 && <div className="dim pad">{emptyText}</div>}
          {items.map((item) => (
            <TreeRow key={item.key} item={item} depth={0} onSelect={onSelect} />
          ))}
        </div>
        {footer && <div className="tree-modal-foot">{footer}</div>}
      </div>
    </ModalScrim>
  );
}

function TreeRow({
  item,
  depth,
  onSelect,
}: {
  item: TreeModalItem;
  depth: number;
  onSelect: (item: TreeModalItem) => void;
}) {
  const expandable = !!item.children && item.children.length > 0;
  const [expanded, setExpanded] = useState(!!item.defaultExpanded);

  if (!expandable) {
    return (
      <button
        type="button"
        className={`tree-modal-row${item.dimmed ? " tree-modal-row-dim" : ""}`}
        style={{ paddingLeft: 12 + depth * 16 }}
        onClick={() => onSelect(item)}
      >
        <span className="tree-modal-row-main">
          <span className="tree-modal-row-title">{item.title}</span>
          {item.subtitle && <span className="tree-modal-row-sub">{item.subtitle}</span>}
        </span>
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        className={`tree-modal-row tree-modal-parent${item.dimmed ? " tree-modal-row-dim" : ""}`}
        style={{ paddingLeft: 12 + depth * 16 }}
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className={`tree-modal-chevron${expanded ? " open" : ""}`} aria-hidden="true">
          ▸
        </span>
        <span className="tree-modal-row-main">
          <span className="tree-modal-row-title">{item.title}</span>
          {item.subtitle && <span className="tree-modal-row-sub">{item.subtitle}</span>}
        </span>
      </button>
      {expanded &&
        item.children!.map((child) => (
          <TreeRow key={child.key} item={child} depth={depth + 1} onSelect={onSelect} />
        ))}
    </>
  );
}
