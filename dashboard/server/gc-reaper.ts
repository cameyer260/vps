import { config } from "./config.js";
import { bridges } from "./bridge.js";
import { getRuntime } from "./runtime.js";

/**
 * Idle reaper for General Chat agents.
 *
 * GC chats are hidden from the Agents tab and live only in the GC tab, whose
 * open id is kept in the browser (RAM + localStorage restore). If the page
 * is gone for good — PWA swiped away, iOS discarding it after days, another
 * device that never knew the id — the container would otherwise run forever
 * with no UI pointing at it. So: every sweep, any dashboard-owned running GC
 * agent whose bridge has had zero connected tabs for longer than
 * `config.gcIdleTimeoutMs` is terminated exactly like the terminate button
 * does (stop + remove, bridge destroyed so open tabs render `exited`).
 *
 * Briefly backgrounding the app is safe: sockets reconnect in seconds, and
 * the timeout (default 1h) only counts continuous client-free time. Agents
 * with an open tab — or not yet attached this server lifetime — are skipped.
 * `GC_IDLE_TIMEOUT_MS=0` (or negative) disables the reaper.
 */

function sweepIntervalMs(): number {
  return Math.min(60_000, Math.max(2_000, Math.floor(config.gcIdleTimeoutMs / 2)));
}

async function sweep(): Promise<void> {
  let agents;
  try {
    agents = await getRuntime().list();
  } catch (err) {
    console.error("[gc-reaper] list failed:", err);
    return;
  }
  const now = Date.now();
  for (const a of agents) {
    if (!a.generalChat || a.origin !== "dashboard" || a.state !== "running") continue;
    const bridge = bridges.get(a.id);
    if (!bridge) continue; // not attached yet — a later sweep picks it up
    const idleSince = bridge.idleSinceMs;
    if (idleSince === null) continue; // tabs attached
    if (now - idleSince < config.gcIdleTimeoutMs) continue;
    console.log(`[gc-reaper] terminating idle general chat ${a.id}`);
    try {
      await getRuntime().stopAndRemove(a.id);
    } catch (err) {
      console.error(`[gc-reaper] stop failed for ${a.id}:`, err);
      continue;
    }
    bridge.destroy();
  }
}

export function startGcReaper(): void {
  if (!(config.gcIdleTimeoutMs > 0)) {
    console.log("[gc-reaper] disabled (GC_IDLE_TIMEOUT_MS <= 0)");
    return;
  }
  const timer = setInterval(() => {
    void sweep();
  }, sweepIntervalMs());
  // Never hold the process open for the reaper (tests, one-shot runs).
  if (typeof timer.unref === "function") timer.unref();
  console.log(
    `[gc-reaper] sweeping idle general chats every ${Math.round(sweepIntervalMs() / 1000)}s ` +
      `(timeout ${Math.round(config.gcIdleTimeoutMs / 1000)}s)`,
  );
}
