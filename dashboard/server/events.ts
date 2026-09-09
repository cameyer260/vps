import { getRuntime } from "./runtime.js";

/**
 * Global fan-out hub for dashboard-wide events — the push replacement for
 * /api/agents polling:
 *
 * - Container lifecycle (start/die/destroy/rename of `agent.kind=pi`
 *   containers) comes straight from the Docker daemon's event stream; clients
 *   resync their agent list when they see it.
 * - Live idle/streaming/exited transitions are relayed from the per-agent
 *   bridges so cards update without refetching.
 */

export type GlobalEvent =
  | { type: "agent_status"; id: string; project: string; status: "idle" | "streaming" | "exited" }
  | { type: "agents_changed"; action: string; id: string };

interface EventsClient {
  send: (payload: string) => void;
}

const clients = new Set<EventsClient>();

/** Register a /ws/events client; returns its cleanup. */
export function addEventsClient(send: (payload: string) => void): () => void {
  const client: EventsClient = { send };
  clients.add(client);
  return () => {
    clients.delete(client);
  };
}

export function broadcastEvent(event: GlobalEvent): void {
  if (clients.size === 0) return;
  const payload = JSON.stringify(event);
  for (const client of clients) {
    try {
      client.send(payload);
    } catch {
      // leave cleanup to the close handler
    }
  }
}

// ---- container lifecycle → agents_changed ----------------------------------
// Transport lives in the runtime (Docker event stream in prod, in-process
// emitter in mock); here we only fan out onto the global socket.

export function watchDockerEvents(): void {
  getRuntime().onLifecycle((e) =>
    broadcastEvent({ type: "agents_changed", action: e.action, id: e.id }),
  );
}
