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
 * Push the current branch to origin. `push origin HEAD` mirrors the host
 * git-bridge (current branch → same-name branch): it never depends on an
 * upstream being configured. If the remote moved ahead — agents push from
 * their containers mid-session, other machines push too — fetch, rebase the
 * local commits onto the upstream and retry once, so "commit & push, then
 * close" self-heals instead of failing. On any failure the full git output
 * comes back so the UI can show the real cause, not just a status code.
 */
async function pushOrigin(dir: string): Promise<GitResult> {
  const first = await runCommand("git", ["push", "origin", "HEAD"], { cwd: dir, timeout: 120_000 });
  if (first.ok) return { ok: true, output: first.output };
  await runCommand("git", ["fetch", "origin", "--prune"], { cwd: dir, timeout: 120_000 });
  const rebase = await runCommand("git", ["rebase", "@{upstream}"], { cwd: dir, timeout: 120_000 });
  if (!rebase.ok) {
    // Either nothing to rebase onto (no upstream — the push output says why)
    // or a genuine conflict. Abort any half-started rebase; on a repo that
    // never entered rebase state this errors harmlessly and is ignored.
    await runCommand("git", ["rebase", "--abort"], { cwd: dir, timeout: 30_000 });
    return {
      ok: false,
      output: `${first.output}\n\n(auto-rebase also failed:\n${rebase.output})`,
    };
  }
  const second = await runCommand("git", ["push", "origin", "HEAD"], { cwd: dir, timeout: 120_000 });
  if (!second.ok) return { ok: false, output: second.output };
  return { ok: true, output: [rebase.output, second.output].filter(Boolean).join("\n") };
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
  const push = await pushOrigin(dir);
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
  const push = await pushOrigin(dir);
  if (!push.ok) return { ok: false, output: `committed but push failed:\n${push.output}` };
  return { ok: true, output: [commit.output, push.output].filter(Boolean).join("\n") };
}
