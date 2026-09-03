import { docker } from "./docker.js";

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

// ---- Docker event stream → agents_changed ----------------------------------

const WATCHED_ACTIONS = new Set(["start", "die", "destroy", "rename"]);

export function watchDockerEvents(): void {
  docker()
    .getEvents({
      filters: {
        type: ["container"],
        event: [...WATCHED_ACTIONS],
        label: ["agent.kind=pi"],
      },
    })
    .then((stream) => {
      let buf = "";
      stream.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        for (;;) {
          const idx = buf.indexOf("\n");
          if (idx === -1) break;
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const ev = JSON.parse(line) as {
              Action?: string;
              action?: string;
              Actor?: { ID?: string };
              id?: string;
            };
            const action = ev.Action ?? ev.action ?? "";
            const id = ev.Actor?.ID ?? ev.id ?? "";
            if (WATCHED_ACTIONS.has(action) && id) {
              broadcastEvent({ type: "agents_changed", action, id });
            }
          } catch {
            // not JSON — ignore
          }
        }
      });
      stream.on("end", resubscribe);
      stream.on("error", resubscribe);
    })
    .catch((err) => {
      console.error("[docker events] subscribe failed:", err);
      resubscribe();
    });
}

function resubscribe(): void {
  // Docker daemon restarted or the stream broke — resubscribe after a pause.
  setTimeout(() => watchDockerEvents(), 5_000).unref();
}
