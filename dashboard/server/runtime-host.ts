import { PassThrough } from "node:stream";
import type { AgentInfo } from "./docker.js";
import {
  hostAttachSocket,
  hostDownError,
  hostKill,
  hostList,
  hostLogs,
  hostSpawn,
  hostSubscribe,
} from "./host-supervisor.js";
import type { AttachedAgent, ContainerRuntime, LifecycleEvent, SpawnOptions } from "./runtime.js";

const HOST_PREFIX = "host-";

export function isHostId(id: string): boolean {
  return id.startsWith(HOST_PREFIX);
}

/**
 * Host-backed `ContainerRuntime` (bare-metal pi via the host supervisor —
 * see docs/host-pi.md). Same seam as Docker: the bridge only ever sees
 * `AttachedAgent` streams, so chat framing is untouched. Degrades to empty
 * list / clear spawn error when the supervisor socket is absent (e.g. unit
 * not installed) — never breaks the jarvis path.
 */
export class HostRuntime implements ContainerRuntime {
  async list(): Promise<AgentInfo[]> {
    let summaries;
    try {
      summaries = await hostList();
    } catch {
      return []; // supervisor down — jarvis agents still list via Docker
    }
    const agents = summaries.map(
      (s) =>
        ({
          id: s.id,
          name: s.id,
          project: s.project,
          directory: s.directory,
          origin: "dashboard",
          state: s.state,
          startedAt: s.startedAt,
          live: null,
          sessionName: null,
          generalChat: false,
          model: null,
          thinkingLevel: null,
          runtime: "host",
        }) satisfies AgentInfo,
    );
    agents.sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name));
    return agents;
  }

  async labels(id: string): Promise<Record<string, string> | null> {
    if (!isHostId(id)) return null;
    try {
      const all = await hostList();
      const found = all.find((a) => a.id === id);
      if (!found) return null;
      return {
        "agent.kind": "pi",
        "agent.project": found.project,
        "agent.origin": "dashboard",
        "agent.runtime": "host",
        "agent.directory": found.directory,
      };
    } catch {
      return null;
    }
  }

  async attach(id: string): Promise<AttachedAgent> {
    const socket = await hostAttachSocket(id);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    socket.on("data", (chunk: Buffer) => {
      stdout.write(chunk);
    });
    const onGone = () => {
      try {
        stdout.end();
      } catch {
        /* ignore */
      }
      try {
        stderr.end();
      } catch {
        /* ignore */
      }
    };
    socket.on("close", onGone);
    socket.on("end", onGone);
    socket.on("error", onGone);
    // Prefill diagnostics (non-fatal when the agent just started).
    hostLogs(id)
      .then((lines) => {
        for (const line of lines.slice(-50)) {
          try {
            stderr.write(line + "\n");
          } catch {
            break;
          }
        }
      })
      .catch(() => {});
    // Bridge writes JSONL to `stdin` and destroys it on terminate: both
    // must hit the supervisor socket. stdout/stderr stay readable sides.
    const stdin = socket as unknown as NodeJS.WritableStream;
    return { stdin, stdout, stderr };
  }

  async stopAndRemove(id: string): Promise<void> {
    try {
      await hostKill(id);
    } catch (err) {
      // Idempotent like Docker 404: a gone agent is success; a down
      // supervisor with a host id is a real error.
      if (String((err as Error)?.message ?? err).includes("unknown agent")) return;
      if (!isHostId(id)) return;
      const msg = String((err as Error)?.message ?? err);
      if (msg === hostDownError()) throw new Error(msg);
      // Unknown-agent from a fresh supervisor (restarted, empty map) is
      // also success — nothing left to kill, no orphan possible.
      if (/unknown agent/i.test(msg)) return;
      throw err;
    }
  }

  async spawn(opts: SpawnOptions): Promise<string> {
    const spawned = await hostSpawn({
      cwd: opts.project,
      sessionPath: opts.sessionPath,
      name: opts.name,
    });
    return spawned.id;
  }

  onLifecycle(cb: (e: LifecycleEvent) => void): () => void {
    const WATCHED = new Set(["start", "die", "destroy", "rename"]);
    return hostSubscribe((e) => {
      if (WATCHED.has(e.action)) cb({ action: e.action as LifecycleEvent["action"], id: e.id });
    });
  }
}
