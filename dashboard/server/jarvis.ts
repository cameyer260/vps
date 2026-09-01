import { execFile } from "node:child_process";
import { config } from "./config.js";

export interface StartAgentOptions {
  project: string; // bare project name (resolved by config.projectDir)
  sessionPath?: string; // resume: absolute path to a pi session file
  name?: string; // pi session display name
  readOnly?: boolean; // start with the read-only extension active
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

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts.readOnly) env.PI_DASHBOARD_READONLY = "1";

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
      { cwd: opts.cwd, timeout: opts.timeout ?? 60_000, maxBuffer: 4 << 20 },
      (err, stdout, stderr) => {
        const output = ((stdout || "") + (stderr || "")).trim();
        resolve({ ok: !err, output: output || (err ? String(err.message) : "") });
      },
    );
  });
}
