/**
 * Git bridge extension — push_to_origin / fetch_from_origin / pull_from_origin.
 *
 * Loaded into every jarvis agent container via `pi -e
 * /home/dev/.pi/agent/git-bridge.ts` (mounted read-only from
 * agent-images/pi-git-bridge/git-bridge.ts by jarvis.sh, all modes).
 *
 * Agent containers hold no GitHub credentials, so plain `git push/pull/fetch`
 * cannot authenticate. These tools send a one-word request ("push" | "fetch" |
 * "pull") over the git-bridge socket (/home/dev/.git-bridge.sock, bind-mounted
 * from the host when jarvis-git-bridge.socket is up) to a host-side handler
 * (tools/jarvis-git-bridge, a systemd user socket service). The handler
 * derives the workspace from the container's own bind mount (SO_PEERCRED →
 * mountinfo — nothing agent-controlled), runs the git command on the host with
 * the gh credential helper, and returns git's output as one JSON line.
 *
 * The agent can therefore only ever operate on its own workspace's origin,
 * never sees a credential, and cannot choose force-pushes, other remotes, or
 * arbitrary git args. See docs/jarvis.md ("Git bridge") for the full contract.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { connect, type Socket } from "node:net";

const BRIDGE_SOCKET = "/home/dev/.git-bridge.sock";
const TIMEOUT_MS = 150_000; // host-side git timeout is 120s

interface BridgeReply {
  ok: boolean;
  op?: string;
  workspace?: string;
  output?: string;
  error?: string;
}

function callBridge(op: string, signal?: AbortSignal): Promise<BridgeReply> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(BRIDGE_SOCKET);
    let data = "";
    const done = (fn: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(
      () => done(() => reject(new Error(`git bridge timed out after ${TIMEOUT_MS / 1000}s`))),
      TIMEOUT_MS,
    );
    const onAbort = () => done(() => reject(new Error("git bridge request aborted")));
    signal?.addEventListener("abort", onAbort, { once: true });

    socket.on("connect", () => socket.write(op + "\n"));
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
    });
    socket.on("error", (err: Error) => {
      done(() =>
        reject(
          new Error(
            err.message.includes("ENOENT")
              ? `git bridge socket not found at ${BRIDGE_SOCKET} — not mounted in this container`
              : err.message,
          ),
        ),
      );
    });
    socket.on("close", () => {
      done(() => {
        const line = data.split("\n").find((l) => l.trim().startsWith("{"));
        if (!line) {
          reject(new Error(`git bridge returned no reply${data.trim() ? `: ${data.trim()}` : ""}`));
          return;
        }
        try {
          resolve(JSON.parse(line) as BridgeReply);
        } catch {
          reject(new Error(`unparseable git bridge reply: ${line.trim()}`));
        }
      });
    });
  });
}

export default function (pi: ExtensionAPI) {
  const tools = [
    {
      name: "push_to_origin",
      op: "push",
      label: "Push to origin",
      description:
        "Push the current branch of this workspace to its origin remote (git push origin HEAD on the host). The container has no git credentials — plain git push cannot work. Takes no parameters.",
      guideline:
        "Use push_to_origin when the user asks to push, publish, or save committed work to GitHub (origin). It pushes the current branch to the same-name branch on origin and returns git's output.",
    },
    {
      name: "fetch_from_origin",
      op: "fetch",
      label: "Fetch from origin",
      description:
        "Fetch the workspace's origin remote (git fetch origin --prune, run on the host). Updates remote-tracking refs only; the working tree is untouched. Takes no parameters.",
      guideline:
        "Use fetch_from_origin to see what changed on origin (then git log/status on the remote-tracking branches) without modifying the working tree.",
    },
    {
      name: "pull_from_origin",
      op: "pull",
      label: "Pull from origin",
      description:
        "Pull the current branch from origin with --ff-only (fast-forward only; refuses to merge), run on the host. Takes no parameters.",
      guideline:
        "Use pull_from_origin when the user asks to pull or sync the workspace with origin. It refuses non-fast-forward pulls — commit locally first and report instead of force-pulling.",
    },
  ];

  for (const t of tools) {
    pi.registerTool({
      name: t.name,
      label: t.label,
      description: t.description,
      promptSnippet: t.label,
      promptGuidelines: [t.guideline],
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, signal) {
        try {
          const reply = await callBridge(t.op, signal);
          const ws = reply.workspace ? ` (workspace: ${reply.workspace})` : "";
          const text = reply.ok
            ? `git ${t.op} succeeded${ws}\n${(reply.output ?? "").trim()}`.trimEnd()
            : `git ${t.op} failed${ws}: ${(reply.output ?? reply.error ?? "unknown error").trim()}`;
          return { content: [{ type: "text", text }], details: { ok: reply.ok, output: reply.output } };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `git ${t.op} could not run: ${message}` }],
            details: { ok: false },
          };
        }
      },
    });
  }
}
