import { PassThrough } from "node:stream";
import type { Duplex } from "node:stream";
import { docker } from "./docker.js";

/**
 * A PiRpcBridge owns the stdin/stdout attachment to one `pi --mode rpc`
 * container and fans its JSONL traffic out to any number of browser WebSockets.
 *
 * - Client commands are rewritten with an internal request id (so concurrent
 *   clients can't collide), and responses are routed back by id with the
 *   client's original id restored.
 * - Events (no id) are broadcast to everyone. pi `extension_ui_request`
 *   notifies are relayed fire-and-forget; the read-only extension announces
 *   mode changes that way, and the last observed read-only state is cached
 *   and sent to new clients in `hello` (notifies are transient). Blocking
 *   dialog requests (select/confirm/input/editor) are dropped — nothing
 *   answers them headlessly.
 * - Browser disconnects never stop the agent; history is recovered via
 *   `get_entries` backfill from the client.
 */

export type LiveStatus = "idle" | "streaming" | "exited";

interface Client {
  send: (payload: string) => void;
}

export interface ClientHandle {
  /** Feed one raw browser message (a JSON string) into the bridge. */
  handleRawMessage(data: string): void;
  /** Remove the client (browser socket closed). */
  close(): void;
}

interface Route {
  client: Client;
  externalId?: string;
  /** Override delivery (used by the backfill reply repackaging). */
  deliver?: (resp: Record<string, unknown>) => void;
}

// Notify messages announcing a read-only mode change (the extension emits
// these on /read-only on|off and at session start). Everything else passes
// through untouched.
const READ_ONLY_RE = /read-only mode (?:is )?(on|off)\b/i;

export class Bridge {
  readonly containerId: string;
  readonly project: string;
  status: LiveStatus = "idle";
  /** Last known get_state info, for the agent list UI. */
  state: {
    model?: string | null;
    thinkingLevel?: string | null;
    sessionName?: string | null;
    sessionFile?: string | null;
  } = {};

  /** Last read-only mode observed from extension notifies; null = never seen. */
  private readOnly: boolean | null = null;
  private clients = new Set<Client>();
  private routes = new Map<string, Route>();
  private internalWaiters = new Map<string, (resp: Record<string, unknown>) => void>();
  private stream: Duplex | null = null;
  private stdoutBuf = "";
  private stderrTail: string[] = [];
  private seq = 0;
  private destroyed = false;

  private constructor(containerId: string, project: string) {
    this.containerId = containerId;
    this.project = project;
  }

  static async create(containerId: string, project: string): Promise<Bridge> {
    const bridge = new Bridge(containerId, project);
    await bridge.attach();
    return bridge;
  }

  private async attach(): Promise<void> {
    const container = docker().getContainer(this.containerId);
    const stream = await new Promise<Duplex>((resolve, reject) => {
      container.attach(
        { stream: true, stdin: true, stdout: true, stderr: true, hijack: true },
        (err, s) => (err ? reject(err) : resolve(s as Duplex)),
      );
    });
    this.stream = stream;

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    container.modem.demuxStream(stream, stdout, stderr);

    stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    stderr.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim()) this.pushStderr(line);
      }
    });
    const onGone = () => this.markExited();
    stream.on("close", onGone);
    stream.on("end", onGone);
    stream.on("error", onGone);

    // Best-effort snapshot for the agent list (model, session name).
    this.request({ type: "get_state" })
      .then((resp) => {
        if (resp["success"] && typeof resp["data"] === "object" && resp["data"] !== null) {
          this.applyState(resp["data"] as Record<string, unknown>);
        }
      })
      .catch(() => {});
  }

  private applyState(data: Record<string, unknown>): void {
    const model = data["model"] as { provider?: string; id?: string } | null | undefined;
    this.state = {
      model: model ? `${model.provider}/${model.id}` : null,
      thinkingLevel: (data["thinkingLevel"] as string | undefined) ?? null,
      sessionName: (data["sessionName"] as string | undefined) ?? null,
      sessionFile: (data["sessionFile"] as string | undefined) ?? null,
    };
  }

  // ---- stdout / RPC framing -------------------------------------------------

  private onStdout(chunk: Buffer): void {
    this.stdoutBuf += chunk.toString("utf8");
    for (;;) {
      const idx = this.stdoutBuf.indexOf("\n");
      if (idx === -1) break;
      const line = this.stdoutBuf.slice(0, idx).replace(/\r$/, "");
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      try {
        this.handleLine(JSON.parse(line) as Record<string, unknown>);
      } catch {
        this.pushStderr(`[unparseable stdout line] ${line.slice(0, 200)}`);
      }
    }
  }

  private handleLine(obj: Record<string, unknown>): void {
    if (obj.type === "response") {
      const id = typeof obj.id === "string" ? obj.id : undefined;
      const waiter = id ? this.internalWaiters.get(id) : undefined;
      if (waiter) {
        this.internalWaiters.delete(id!);
        waiter(obj);
        return;
      }
      const route = id ? this.routes.get(id) : undefined;
      if (route) {
        this.routes.delete(id!);
        const { externalId, deliver } = route;
        const payload = {
          type: "response",
          ...obj,
          ...(externalId !== undefined ? { id: externalId } : {}),
        };
        if (deliver) deliver(payload);
        else this.sendTo(route.client, payload);
        if (obj.command === "get_state" && obj.success) this.applyState(obj.data as Record<string, unknown>);
        return;
      }
      // Unroutable response (e.g. client vanished) — drop, but log failures.
      if (obj.success === false) this.pushStderr(`[rpc error] ${JSON.stringify(obj).slice(0, 300)}`);
      return;
    }

    if (obj.type === "extension_ui_request") {
      if ((obj.method as string) === "notify") {
        const message = typeof obj.message === "string" ? obj.message : "";
        const m = message.match(READ_ONLY_RE);
        if (m) {
          this.readOnly = m[1]!.toLowerCase() === "on";
          // Structured signal for connected tabs (hello covers later ones).
          this.broadcast({ type: "read_only", value: this.readOnly });
        }
        this.broadcast({ type: "agent", event: obj });
      }
      return;
    }

    // Plain pi event: broadcast + derive status.
    const type = obj.type as string;
    if (type === "agent_start") this.setStatus("streaming");
    else if (type === "agent_settled") this.setStatus("idle");
    this.broadcast({ type: "agent", event: obj });
  }

  private setStatus(status: LiveStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.broadcast({ type: "status", status });
  }

  private markExited(): void {
    if (this.destroyed) return;
    this.status = "exited";
    this.broadcast({ type: "exited" });
    // Drop the bridge after a grace period so UIs can render the exit first.
    setTimeout(() => bridges.delete(this.containerId), 60_000).unref();
  }

  destroy(): void {
    this.destroyed = true;
    this.routes.clear();
    this.internalWaiters.clear();
    this.stream?.destroy();
    bridges.delete(this.containerId);
  }

  // ---- client wiring ---------------------------------------------------------

  addClient(send: (payload: string) => void): ClientHandle {
    const client: Client = { send };
    this.clients.add(client);
    this.sendTo(client, {
      type: "hello",
      containerId: this.containerId,
      project: this.project,
      ...(this.readOnly !== null ? { readOnly: this.readOnly } : {}),
    });
    this.sendTo(client, { type: "status", status: this.status });

    const remove = () => {
      this.clients.delete(client);
      for (const [id, route] of this.routes) {
        if (route.client === client) this.routes.delete(id);
      }
    };

    return {
      handleRawMessage: (data: string) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(data) as Record<string, unknown>;
        } catch {
          return;
        }
        try {
          this.handleClientMessage(client, msg);
        } catch (err) {
          this.sendTo(client, { type: "bridge_error", error: String(err) });
        }
      },
      close: remove,
    };
  }

  private handleClientMessage(client: Client, msg: Record<string, unknown>): void {
    switch (msg.type) {
      case "cmd": {
        const command = { ...(msg.command as Record<string, unknown>) };
        const externalId = typeof command.id === "string" ? command.id : undefined;
        const internalId = `c${++this.seq}`;
        this.routes.set(internalId, { client, externalId });
        command.id = internalId;
        this.writeToPi(command);
        return;
      }
      case "backfill": {
        const reqId = typeof msg.reqId === "string" ? msg.reqId : "";
        const since = typeof msg.since === "string" ? msg.since : undefined;
        const command: Record<string, unknown> = { type: "get_entries" };
        if (since) command.since = since;
        const internalId = `c${++this.seq}`;
        this.routes.set(internalId, {
          client,
          deliver: (resp) => this.sendBackfill(client, reqId, resp),
        });
        this.writeToPi({ ...command, id: internalId });
        return;
      }
      default:
        this.sendTo(client, { type: "bridge_error", error: `unknown message type: ${String(msg.type)}` });
    }
  }

  /** Repackage a get_entries response as the client's backfill reply. */
  private sendBackfill(client: Client, reqId: string, resp: Record<string, unknown>): void {
    const body =
      resp.success && typeof resp.data === "object" && resp.data !== null
        ? (resp.data as { entries?: unknown[]; leafId?: unknown })
        : { error: resp.error ?? "backfill failed" };
    this.sendTo(client, { type: "backfill", reqId, success: !!resp.success, ...body });
  }

  // ---- sending ----------------------------------------------------------------

  private writeToPi(obj: unknown): void {
    if (!this.stream || this.status === "exited") {
      throw new Error("agent container is not attached (exited?)");
    }
    this.stream.write(JSON.stringify(obj) + "\n");
  }

  private sendTo(client: Client, msg: unknown): void {
    try {
      client.send(JSON.stringify(msg));
    } catch {
      // socket already closing
    }
  }

  private broadcast(msg: unknown): void {
    const payload = JSON.stringify(msg);
    for (const client of this.clients) {
      try {
        client.send(payload);
      } catch {
        // leave cleanup to the close handler
      }
    }
  }

  /** Promise-style internal request (attach-time get_state etc). */
  private request(command: Record<string, unknown>, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = `i${++this.seq}`;
      const timer = setTimeout(() => {
        this.internalWaiters.delete(id);
        reject(new Error(`internal request timed out: ${command.type}`));
      }, timeoutMs);
      this.internalWaiters.set(id, (resp) => {
        clearTimeout(timer);
        resolve(resp);
      });
      this.writeToPi({ ...command, id });
    });
  }

  stderrLines(): string[] {
    return [...this.stderrTail];
  }

  private pushStderr(line: string): void {
    this.stderrTail.push(line);
    if (this.stderrTail.length > 200) this.stderrTail.splice(0, this.stderrTail.length - 200);
  }
}

// ---- registry -----------------------------------------------------------------

export const bridges = new Map<string, Bridge>();

export async function ensureBridge(containerId: string, project: string): Promise<Bridge> {
  const existing = bridges.get(containerId);
  if (existing) return existing;
  const bridge = await Bridge.create(containerId, project);
  bridges.set(containerId, bridge);
  return bridge;
}
