import type { AgentInfo } from "../types";

export type AgentStatusClass = "streaming" | "idle" | "dead";

/**
 * Shared status→color map (spec §2 + sketches): `streaming`/working = orange,
 * `idle`/waiting = green, `exited`/dead = dim. The `.dot.<cls>` CSS classes
 * in app.css are the visual side of this map — keep the two in sync.
 */
export const STATUS_COLORS: Record<AgentStatusClass, string> = {
  streaming: "var(--orange)",
  idle: "var(--green)",
  dead: "var(--text-dim)",
};

export function statusDot(a: AgentInfo): { cls: AgentStatusClass; label: string } {
  if (a.state !== "running") return { cls: "dead", label: a.state };
  if (a.live === "streaming") return { cls: "streaming", label: "streaming" };
  if (a.live === "exited") return { cls: "dead", label: "exited" };
  return { cls: "idle", label: "idle" };
}
