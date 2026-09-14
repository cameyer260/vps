import type { AgentInfo } from "./docker.js";
import { DockerRuntime } from "./runtime-docker.js";
import { HostRuntime, isHostId } from "./runtime-host.js";
import { MockRuntime } from "./mock/runtime.js";

/**
 * Seam hiding every VPS touch-point behind one interface (mock-VPS plan,
 * Phase 0). Production code talks only to `ContainerRuntime`; `getRuntime()`
 * returns the combined Docker + host-supervisor implementation unless
 * `MOCK_VPS=1` (dev only).
 *
 * Mock code is dead code unless `MOCK_VPS=1` **and** `NODE_ENV !==
 * "production"`. `getRuntime()` throws at boot if `MOCK_VPS=1` with
 * `NODE_ENV=production`. `deploy.sh` never sets `MOCK_VPS`.
 */

export interface SpawnOptions {
  /** Resolved host dir (same value the start route passes to jarvis today). */
  project: string;
  /** Resume file (validated by the route, unchanged). */
  sessionPath?: string;
  /** Sticky spawn name → bridge explicitName. */
  name?: string;
  /** → PI_DASHBOARD_READONLY equivalent (jarvis only; host ignores it). */
  readOnly?: boolean;
  /** General Chat spawn: append the GC system prompt server-side. */
  generalChat?: boolean;
  /** Spawn path: jarvis containers (default) vs bare-metal host pi. */
  runtime?: "jarvis" | "host";
}

export interface AttachedAgent {
  /** Bridge writes JSONL here. */
  stdin: NodeJS.WritableStream;
  /** Already-demuxed stdout lines here. */
  stdout: NodeJS.ReadableStream;
  /** Diagnostics → bridge stderr tail. */
  stderr: NodeJS.ReadableStream;
}

export interface LifecycleEvent {
  action: "start" | "die" | "destroy" | "rename";
  id: string;
}

export interface ContainerRuntime {
  /** → GET /api/agents. */
  list(): Promise<AgentInfo[]>;
  /** → /ws/agent/:id guard. */
  labels(id: string): Promise<Record<string, string> | null>;
  /** → bridge. */
  attach(id: string): Promise<AttachedAgent>;
  /** → terminate route. */
  stopAndRemove(id: string): Promise<void>;
  /** → start route (returns id). */
  spawn(opts: SpawnOptions): Promise<string>;
  /** → /ws/events. Returns an unsubscriber. */
  onLifecycle(cb: (e: LifecycleEvent) => void): () => void;
}

/** Production runtime: Docker (jarvis) + host supervisor merged behind one seam. */
class CombinedRuntime implements ContainerRuntime {
  constructor(
    private readonly dockerRt: ContainerRuntime,
    private readonly hostRt: ContainerRuntime,
  ) {}

  async list(): Promise<AgentInfo[]> {
    const [dockerAgents, hostAgents] = await Promise.all([
      this.dockerRt.list().catch((err) => {
        console.error("[runtime] docker list failed:", err);
        return [] as AgentInfo[];
      }),
      this.hostRt.list().catch(() => [] as AgentInfo[]),
    ]);
    const out = [...dockerAgents, ...hostAgents];
    out.sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name));
    return out;
  }

  labels(id: string): Promise<Record<string, string> | null> {
    return isHostId(id) ? this.hostRt.labels(id) : this.dockerRt.labels(id);
  }

  attach(id: string): Promise<AttachedAgent> {
    return isHostId(id) ? this.hostRt.attach(id) : this.dockerRt.attach(id);
  }

  stopAndRemove(id: string): Promise<void> {
    return isHostId(id) ? this.hostRt.stopAndRemove(id) : this.dockerRt.stopAndRemove(id);
  }

  spawn(opts: SpawnOptions): Promise<string> {
    return opts.runtime === "host" ? this.hostRt.spawn(opts) : this.dockerRt.spawn(opts);
  }

  onLifecycle(cb: (e: LifecycleEvent) => void): () => void {
    const offDocker = this.dockerRt.onLifecycle(cb);
    const offHost = this.hostRt.onLifecycle(cb);
    return () => {
      try {
        offDocker();
      } catch {
        /* ignore */
      }
      try {
        offHost();
      } catch {
        /* ignore */
      }
    };
  }
}

let combinedRt: ContainerRuntime | null = null;
let mockRt: MockRuntime | null = null;

export function getRuntime(): ContainerRuntime {
  if (process.env.MOCK_VPS === "1") {
    if (process.env.NODE_ENV === "production") {
      throw new Error("MOCK_VPS=1 is not allowed when NODE_ENV=production");
    }
    mockRt ??= new MockRuntime();
    return mockRt;
  }
  combinedRt ??= new CombinedRuntime(new DockerRuntime(), new HostRuntime());
  return combinedRt;
}
