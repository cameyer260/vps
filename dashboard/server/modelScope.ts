import fs from "node:fs";
import { config } from "./config.js";

/**
 * Scoped-models source for the picker: pi resolves a session's scope at
 * startup from `--models` or the `enabledModels` key in the global settings
 * file — but no RPC command returns it (`get_available_models` is the full
 * available set, `get_state` omits scope, `cycle_model` only says whether
 * the current model is scoped). The dashboard never sets a scope, so the
 * only live source is the settings file, which this server already runs
 * alongside (same host paths as projects/sessions). Reads the same file pi
 * reads and returns its patterns verbatim; matching against the available
 * list happens client-side, where that list already lives.
 *
 * Returns null when the file is missing/unparseable or the key is
 * absent/empty (scope empty → the picker shows the single available list).
 */
export function readScopePatterns(): string[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(config.piSettingsFile, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const patterns = (parsed as { enabledModels?: unknown } | null)?.enabledModels;
  if (!Array.isArray(patterns)) return null;
  const out = patterns
    .filter((p): p is string => typeof p === "string")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return out.length > 0 ? out : null;
}
