import { execFile } from "node:child_process";
import path from "node:path";
import { config } from "./config.js";
import { GENERAL_CHAT_SYSTEM_PROMPT } from "./general-chat.js";

export interface StartAgentOptions {
  project: string; // bare project name (resolved by config.projectDir)
  sessionPath?: string; // resume: absolute path to a pi session file
  name?: string; // pi session display name
  readOnly?: boolean; // start with the read-only extension active
  /** General Chat spawn: append the GC system prompt (server-side only). */
  generalChat?: boolean;
}

/**
 * Start a headless pi agent by shelling out to `jarvis rpc`. jarvis is the
 * single source of truth for the docker run flags; the dashboard only gets a
 * container ID back and uses the Docker API from then on.
 */
export function startAgent(opts: StartAgentOptions): Promise<string> {
  const dir = opts.project;
  const args = ["rpc", dir];
  if (opts.sessionPath) args.push("--session", opts.sessionPath);
  if (opts.name) args.push("-n", opts.name);
  if (opts.generalChat) args.push("--append-system-prompt", GENERAL_CHAT_SYSTEM_PROMPT);

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts.readOnly) env.PI_DASHBOARD_READONLY = "1";
  // General Chat spawns carry the GC label (Group F: the Agents tab reads
  // `agent.generalchat` to section open conversations apart).
  if (opts.generalChat) env.DASHBOARD_GENERAL_CHAT = "1";

  return new Promise((resolve, reject) => {
    execFile(
      config.jarvisBin,
      args,
      { env, timeout: 120_000, maxBuffer: 4 << 20 },
      (err, stdout, stderr) => {
        const id = stdout.trim();
        if (err || !id) {
          const detail = (stderr || err?.message || "no output").trim();
          reject(new Error(`jarvis rpc failed: ${detail.split("\n").slice(-12).join("\n")}`));
        } else {
          resolve(id.split("\n").pop()!.trim());
        }
      },
    );
  });
}

/** Run a shell command as the same user (dev), used for host-side git ops. */
export function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number } = {},
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeout ?? 60_000,
        maxBuffer: 4 << 20,
        // Containment: pin repo discovery inside the target dir — git
        // checks the starting dir itself, and the ceiling blocks ascending
        // into the parent from below, so git never sees an enclosing repo
        // and every project-scoped op stays inside its project folder.
        // (The ceiling must be the PARENT: ceiling == cwd blocks nothing.)
        env: {
          ...process.env,
          ...(opts.cwd ? { GIT_CEILING_DIRECTORIES: path.dirname(opts.cwd) } : {}),
        },
      },
      (err, stdout, stderr) => {
        const output = ((stdout || "") + (stderr || "")).trim();
        resolve({ ok: !err, output: output || (err ? String(err.message) : "") });
      },
    );
  });
}
