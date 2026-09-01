import Dockerode from "dockerode";

let client: Dockerode | null = null;

export function docker(): Dockerode {
  client ??= new Dockerode({ socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock" });
  return client;
}

export interface AgentInfo {
  id: string;
  name: string;
  project: string;
  origin: string | null;
  state: string; // created | running | paused | restarting | removing | exited | dead
  startedAt: string | null; // ISO
  /** Live chat status from the bridge, when the dashboard has attached. */
  live: "idle" | "streaming" | "exited" | null;
  sessionName: string | null;
  model: string | null;
  thinkingLevel: string | null;
}

export async function listPiContainers(): Promise<AgentInfo[]> {
  const summaries = await docker().listContainers({
    all: true,
    filters: { label: ["agent.kind=pi"] },
  });
  const agents = await Promise.all(
    summaries.map(async (s) => {
      const labels = s.Labels ?? {};
      let startedAt: string | null = null;
      let sessionName: string | null = null;
      let model: string | null = null;
      let thinkingLevel: string | null = null;
      try {
        const info = await docker().getContainer(s.Id).inspect();
        startedAt = info.State?.StartedAt ?? null;
      } catch {
        // container may have been removed concurrently
      }
      return {
        id: s.Id,
        name: (s.Names?.[0] ?? "").replace(/^\//, ""),
        project: labels["agent.project"] ?? "unknown",
        origin: labels["agent.origin"] ?? null,
        state: s.State,
        startedAt,
        live: null,
        sessionName,
        model,
        thinkingLevel,
      } satisfies AgentInfo;
    }),
  );
  agents.sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name));
  return agents;
}

export async function containerState(id: string): Promise<string | null> {
  try {
    const info = await docker().getContainer(id).inspect();
    return info.State?.Status ?? null;
  } catch {
    return null;
  }
}

export async function containerLabels(id: string): Promise<Record<string, string> | null> {
  try {
    const info = await docker().getContainer(id).inspect();
    return (info.Config?.Labels ?? {}) as Record<string, string>;
  } catch {
    return null;
  }
}

export async function stopAndRemove(id: string): Promise<void> {
  const c = docker().getContainer(id);
  try {
    await c.stop({ t: 10 });
  } catch (err) {
    // 304 = already stopped; fine
    if (!isDockerStatusErr(err, 304)) throw err;
  }
  try {
    await c.remove({ force: true });
  } catch (err) {
    if (!isDockerStatusErr(err, 404)) throw err;
  }
}

function isDockerStatusErr(err: unknown, code: number): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "statusCode" in err &&
    (err as { statusCode?: number }).statusCode === code
  );
}
