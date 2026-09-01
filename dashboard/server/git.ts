import { config } from "./config.js";
import { projectDir } from "./config.js";
import { runCommand } from "./jarvis.js";

export interface GitResult {
  ok: boolean;
  output: string;
}

/** Host-side `git pull --ff-only` (surfaces divergence instead of merging). */
export function gitPull(dir: string): Promise<GitResult> {
  return runCommand("git", ["pull", "--ff-only"], { cwd: dir, timeout: 120_000 });
}

export interface GitStatus {
  ok: boolean;
  dirty: boolean;
  porcelain: string;
  branch: string | null;
}

export function gitStatus(dir: string): Promise<GitStatus> {
  return runCommand("git", ["status", "--porcelain", "--branch"], { cwd: dir }).then((r) => {
    if (!r.ok) return { ok: false, dirty: false, porcelain: r.output, branch: null };
    const lines = r.output.split("\n");
    const branch = lines[0]?.startsWith("## ") ? lines[0].slice(3) : null;
    const porcelain = lines.slice(1).filter(Boolean).join("\n");
    return { ok: true, dirty: porcelain.length > 0, porcelain, branch };
  });
}

/**
 * Stage only the given paths, commit, push. Used by the notes viewer and the
 * close-agent flow so dirt from agents isn't swept up.
 */
export async function gitCommitPush(
  dir: string,
  paths: string[],
  message: string,
): Promise<GitResult> {
  if (paths.length === 0) return { ok: false, output: "no files to commit" };
  const add = await runCommand("git", ["add", "--", ...paths], { cwd: dir });
  if (!add.ok) return { ok: false, output: `git add failed:\n${add.output}` };
  const commit = await runCommand("git", ["commit", "-m", message], { cwd: dir });
  if (!commit.ok) {
    const nothing = commit.output.includes("nothing to commit");
    if (nothing) return { ok: true, output: "nothing to commit (working tree clean for staged paths)" };
    return { ok: false, output: `git commit failed:\n${commit.output}` };
  }
  const push = await runCommand("git", ["push"], { cwd: dir, timeout: 120_000 });
  if (!push.ok) return { ok: false, output: `committed but push failed:\n${push.output}` };
  return { ok: true, output: [commit.output, push.output].filter(Boolean).join("\n") };
}

/** Stage everything (git add -A), commit, push — used when closing an agent. */
export async function gitCommitAllPush(dir: string, message: string): Promise<GitResult> {
  const add = await runCommand("git", ["add", "-A"], { cwd: dir });
  if (!add.ok) return { ok: false, output: `git add failed:\n${add.output}` };
  const commit = await runCommand("git", ["commit", "-m", message], { cwd: dir });
  if (!commit.ok) {
    if (commit.output.includes("nothing to commit"))
      return { ok: true, output: "nothing to commit (working tree clean)" };
    return { ok: false, output: `git commit failed:\n${commit.output}` };
  }
  const push = await runCommand("git", ["push"], { cwd: dir, timeout: 120_000 });
  if (!push.ok) return { ok: false, output: `committed but push failed:\n${push.output}` };
  return { ok: true, output: [commit.output, push.output].filter(Boolean).join("\n") };
}
