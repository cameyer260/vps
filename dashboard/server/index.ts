import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { config } from "./config.js";
import { api } from "./routes.js";
import { bridges, ensureBridge } from "./bridge.js";
import { addEventsClient, watchDockerEvents } from "./events.js";
import { containerLabels } from "./docker.js";
import type { ClientHandle } from "./bridge.js";

const app = new Hono();

app.route("/api", api);

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// ---- WebSocket per open chat ---------------------------------------------

app.get(
  "/ws/agent/:id",
  upgradeWebSocket(async (c) => {
    const containerId = c.req.param("id") ?? "";
    let client: ClientHandle | null = null;
    return {
      onOpen(_event, ws) {
        void (async () => {
          let bridge = bridges.get(containerId);
          if (!bridge) {
            const labels = await containerLabels(containerId);
            if (!labels || labels["agent.kind"] !== "pi") {
              ws.close(1008, "not a pi agent container");
              return;
            }
            bridge = await ensureBridge(containerId, labels["agent.project"] ?? "unknown");
          }
          client = bridge.addClient((payload) => ws.send(payload));
        })().catch((err) => {
          console.error(`[ws] attach failed for ${containerId}:`, err);
          ws.close(1011, "attach failed");
        });
      },
      onMessage(event) {
        client?.handleRawMessage(String(event.data));
      },
      onClose() {
        client?.close();
        client = null;
      },
    };
  }),
);

// ---- Global events socket (agent list push) ---------------------------------
// Replaces /api/agents polling: clients get container lifecycle (→ refetch)
// and per-agent status transitions (→ patch the card in place) pushed.

app.get(
  "/ws/events",
  upgradeWebSocket(async () => {
    let remove: (() => void) | null = null;
    return {
      onOpen(_event, ws) {
        remove = addEventsClient((payload) => ws.send(payload));
      },
      onClose() {
        remove?.();
        remove = null;
      },
    };
  }),
);

// ---- SPA / static files -----------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

app.get("*", async (c) => {
  const rel = decodeURIComponent(c.req.path).replace(/^\/+/, "");
  const abs = path.resolve(config.wwwDir, rel);
  const relative = path.relative(path.resolve(config.wwwDir), abs);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return c.notFound();
  try {
    const data = await fs.promises.readFile(abs);
    const type = MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream";
    return c.body(data, 200, { "Content-Type": type, "Cache-Control": "no-cache" });
  } catch {
    if (path.extname(rel)) return c.notFound();
    // SPA fallback: unknown paths render the app shell
    const index = await fs.promises.readFile(path.join(config.wwwDir, "index.html"));
    return c.body(index, 200, { "Content-Type": MIME[".html"], "Cache-Control": "no-cache" });
  }
});

// ---- go ----------------------------------------------------------------------

watchDockerEvents();

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`dashboard listening on http://0.0.0.0:${info.port}`);
});
injectWebSocket(server);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}

// A phone-facing service shouldn't die from one bad event; log and keep going.
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
