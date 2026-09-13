import { createPortal } from "react-dom";
import type { ReactNode } from "react";

interface Props {
  onClose: () => void;
  /** Extra scrim classes (e.g. TreeModal's left-slide variant). */
  className?: string;
  children: ReactNode;
}

/**
 * Viewport-centered modal scrim, portaled to `document.body`.
 *
 * Why the portal: several modal triggers live under ancestors with
 * `backdrop-filter` (chat-head, tab-header, composer — plus `.modal-scrim`
 * itself for nested pickers). Per spec `backdrop-filter` makes that ancestor
 * the containing block for `position: fixed` descendants, so an inline
 * `.modal-scrim { position: fixed; inset: 0 }` covers only the ancestor's box
 * (e.g. the 52px header strip) and the dialog pins to the top, clipped —
 * instead of centering on the viewport. Portaling escapes every such
 * ancestor, so `inset: 0` always means the viewport.
 */
export function ModalScrim({ onClose, className, children }: Props) {
  return createPortal(
    <div className={className ? `modal-scrim ${className}` : "modal-scrim"} onClick={onClose}>
      {children}
    </div>,
    document.body,
  );
}
