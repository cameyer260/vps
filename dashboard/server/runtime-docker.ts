import { PassThrough } from "node:stream";
import type { Duplex } from "node:stream";
import { containerLabels, docker, listPiContainers, stopAndRemove } from "./docker.js";
import { startAgent } from "./jarvis.js";
import { listAllModels, type AllModel } from "./piModels.js";
import type { AttachedAgent, ContainerRuntime, LifecycleEvent, SpawnOptions } from "./runtime.js";

/**
 * Docker-backed `ContainerRuntime` (production path). Implements the seam by
 * delegating to the existing `docker.ts` / `jarvis.ts` bodies — no behavior
 * change. The attach + `demuxStream` block and the `getEvents` loop used to
 * live in `bridge.ts` / `events.ts`; they live here now so the mock can swap
 * the transport without touching bridge framing, id-rewriting, state cache,
 * or broadcast logic.
 */
export class DockerRuntime implements ContainerRuntime {
  list() {
    return listPiContainers();
  }

  labels(id: string) {
    return containerLabels(id);
  }

  async attach(id: string): Promise<AttachedAgent> {
    const container = docker().getContainer(id);
    const stream = await new Promise<Duplex>((resolve, reject) => {
      container.attach(
        { stream: true, stdin: true, stdout: true, stderr: true, hijack: true },
        (err, s) => (err ? reject(err) : resolve(s as Duplex)),
      );
    });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    container.modem.demuxStream(stream, stdout, stderr);
    return { stdin: stream, stdout, stderr };
  }

  stopAndRemove(id: string): Promise<void> {
    return stopAndRemove(id);
  }

  spawn(opts: SpawnOptions): Promise<string> {
    return startAgent({
      project: opts.project,
      sessionPath: opts.sessionPath,
      name: opts.name,
      readOnly: opts.readOnly,
    });
  }

  listModels(): Promise<AllModel[]> {
    return listAllModels();
  }

  onLifecycle(cb: (e: LifecycleEvent) => void): () => void {
    const WATCHED = new Set(["start", "die", "destroy", "rename"]);
    const subscribe = () => {
      docker()
        .getEvents({
          filters: {
            type: ["container"],
            event: [...WATCHED],
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
                if (WATCHED.has(action) && id) {
                  cb({ action: action as LifecycleEvent["action"], id });
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
    };
    const resubscribe = () => {
      // Docker daemon restarted or the stream broke — resubscribe after a pause.
      setTimeout(subscribe, 5_000).unref();
    };
    subscribe();
    // Docker offers no clean unsubscribe for the filtered event stream;
    // the dashboard subscribes once at boot and never unsubscribes.
    return () => {};
  }
}
