import type { AgentInfo } from "./docker.js";
import type { AllModel } from "./piModels.js";
import { DockerRuntime } from "./runtime-docker.js";
import { MockRuntime } from "./mock/runtime.js";

/**
 * Seam hiding every VPS touch-point behind one interface (mock-VPS plan,
 * Phase 0). Production code talks only to `ContainerRuntime`; `getRuntime()`
 * returns the Docker-backed implementation unless `MOCK_VPS=1` (dev only).
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
  /** → PI_DASHBOARD_READONLY equivalent. */
  readOnly?: boolean;
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
  /** → GET /api/models (full catalog, wider than an agent's scope). */
  listModels(): Promise<AllModel[]>;
  /** → /ws/events. Returns an unsubscriber. */
  onLifecycle(cb: (e: LifecycleEvent) => void): () => void;
}

let dockerRt: ContainerRuntime | null = null;
let mockRt: MockRuntime | null = null;

export function getRuntime(): ContainerRuntime {
  if (process.env.MOCK_VPS === "1") {
    if (process.env.NODE_ENV === "production") {
      throw new Error("MOCK_VPS=1 is not allowed when NODE_ENV=production");
    }
    mockRt ??= new MockRuntime();
    return mockRt;
  }
  dockerRt ??= new DockerRuntime();
  return dockerRt;
}
