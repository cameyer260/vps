import net from "node:net";
import { config } from "./config.js";

/** Client for the host pi supervisor socket (see docs/host-pi.md). */

export interface HostAgentSummary {
  id: string;
  directory: string;
  project: string;
  pid: number;
  startedAt: string;
  state: string;
}

function sockPath(): string {
  return config.hostSupervisorSock;
}

function readLine(socket: net.Socket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("host supervisor: response timeout"));
    }, timeoutMs);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    };
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        cleanup();
        resolve(line);
      } else if (buf.length > 256 * 1024) {
        cleanup();
        reject(new Error("host supervisor: response too large"));
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error(hostDownError()));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

export function hostDownError(): string {
  return `host supervisor not running (${sockPath()}; systemctl --user enable --now pi-host-supervisor.service — see docs/host-pi.md)`;
}

function connect(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ path: sockPath() });
    s.once("connect", () => resolve(s));
    s.once("error", (err: unknown) => {
      const code = (err as { code?: string })?.code;
      if (code === "ENOENT" || code === "ECONNREFUSED" || code === "EACCES") {
        reject(new Error(hostDownError()));
      } else {
        reject(err);
      }
    });
  });
}

/** One request → one JSON reply line (unary ops). */
export async function hostRpc(
  req: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  const s = await connect();
  try {
    s.write(JSON.stringify(req) + "\n");
    const line = await readLine(s, timeoutMs);
    try {
      s.end();
    } catch {
      /* ignore */
    }
    try {
      s.destroy();
    } catch {
      /* ignore */
    }
    return JSON.parse(line) as Record<string, unknown>;
  } catch (err) {
    try {
      s.destroy();
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export async function hostList(): Promise<HostAgentSummary[]> {
  const res = await hostRpc({ op: "list" });
  if (!res["ok"]) throw new Error(String(res["error"] ?? "host list failed"));
  return (res["agents"] as HostAgentSummary[]) ?? [];
}

export async function hostSpawn(opts: {
  cwd: string;
  sessionPath?: string;
  name?: string;
}): Promise<{ id: string; pid: number; directory: string; project: string; startedAt: string }> {
  const res = await hostRpc(
    { op: "spawn", cwd: opts.cwd, sessionPath: opts.sessionPath, name: opts.name },
    60_000,
  );
  if (!res["ok"]) throw new Error(String(res["error"] ?? "host spawn failed"));
  return {
    id: String(res["id"]),
    pid: Number(res["pid"]),
    directory: String(res["directory"]),
    project: String(res["project"]),
    startedAt: String(res["startedAt"] ?? new Date().toISOString()),
  };
}

export async function hostKill(id: string): Promise<void> {
  const res = await hostRpc({ op: "kill", id });
  if (!res["ok"]) throw new Error(String(res["error"] ?? "host kill failed"));
}

export async function hostLogs(id: string): Promise<string[]> {
  const res = await hostRpc({ op: "logs", id });
  if (!res["ok"]) return [];
  return (res["stderr"] as string[]) ?? [];
}

/**
 * Open an attach connection: resolves with the socket already in proxy mode
 * (server sent {"ok":true}; subsequent bytes flow both ways to pi stdio).
 */
export async function hostAttachSocket(id: string, timeoutMs = 15_000): Promise<net.Socket> {
  const s = await connect();
  s.write(JSON.stringify({ op: "attach", id }) + "\n");
  const line = await readLine(s, timeoutMs);
  let res: Record<string, unknown>;
  try {
    res = JSON.parse(line) as Record<string, unknown>;
  } catch {
    try {
      s.destroy();
    } catch {
      /* ignore */
    }
    throw new Error("host supervisor: bad attach reply");
  }
  if (!res["ok"]) {
    try {
      s.destroy();
    } catch {
      /* ignore */
    }
    throw new Error(String(res["error"] ?? "host attach failed"));
  }
  // Remove the one-shot close listener from readLine (it already cleaned
  // itself up on resolve); the socket now streams raw pi stdout.
  s.removeAllListeners("close");
  return s;
}

/** Long-lived lifecycle subscription; reconnects with backoff. */
export function hostSubscribe(cb: (e: { action: string; id: string }) => void): () => void {
  let dead = false;
  let socket: net.Socket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const subscribe = () => {
    if (dead) return;
    const s = net.createConnection({ path: sockPath() });
    socket = s;
    let buf = "";
    let handshook = false;
    s.on("connect", () => {
      s.write(JSON.stringify({ op: "subscribe" }) + "\n");
    });
    s.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      for (;;) {
        const idx = buf.indexOf("\n");
        if (idx === -1) break;
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (!handshook) {
          // First line is the {"ok":true} handshake.
          handshook = !!msg["ok"];
          continue;
        }
        const action = msg["action"];
        const id = msg["id"];
        if (typeof action === "string" && typeof id === "string") {
          try {
            cb({ action, id });
          } catch {
            /* listener failure must not break the emitter */
          }
        }
      }
    });
    const resubscribe = () => {
      if (dead) return;
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
      socket = null;
      if (retry) return;
      retry = setTimeout(() => {
        retry = null;
        subscribe();
      }, 5000);
      retry.unref?.();
    };
    s.on("close", resubscribe);
    s.on("error", resubscribe);
  };
  subscribe();
  return () => {
    dead = true;
    if (retry) clearTimeout(retry);
    try {
      socket?.destroy();
    } catch {
      /* ignore */
    }
    socket = null;
  };
}
