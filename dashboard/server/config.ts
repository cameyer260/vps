import path from "node:path";

// Everything resolvable at deploy time comes from the environment (see
// deploy.sh / the Dockerfile). Defaults match the VPS layout.
export const config = {
  port: Number(process.env.PORT ?? 3000),
  projectsDir: process.env.AGENT_PROJECTS_DIR ?? "/home/dev/projects",
  notesDir: process.env.NOTES_DIR ?? "/home/dev/notes",
  sessionsDir: process.env.PI_SESSIONS_DIR ?? "/home/dev/.pi/agent/sessions",
  jarvisBin: process.env.JARVIS_BIN ?? "/home/dev/vps/agent-images/jarvis.sh",
  skillsDir: process.env.AGENT_SKILLS_DIR ?? "/home/dev/.agents",
  /** Global pi settings file — the picker's scoped tab reads `enabledModels`
   *  from here (same file pi resolves session scope from at startup). */
  piSettingsFile: process.env.PI_SETTINGS_FILE ?? "/home/dev/.pi/agent/settings.json",
  /** Screenshots inbox: scp target for the Mac screenshot tool and the
   *  chat image-upload destination (mounted ro into every jarvis agent at
   *  the same host path, rw in the dashboard container). */
  screenshotsDir: process.env.SCREENSHOTS_DIR ?? "/home/dev/screenshots",
  /** Home dir host agents are confined to (`hostDir()` whitelist root). */
  homeDir: process.env.HOME_DIR ?? process.env.HOME ?? "/home/dev",
  /** Host pi supervisor socket (see docs/host-pi.md). Overridden in tests. */
  hostSupervisorSock:
    process.env.PI_HOST_SUPERVISOR_SOCK ?? "/run/user/1000/pi-host-supervisor.sock",
  wwwDir: process.env.WWW_DIR ?? path.resolve(process.cwd(), "dist"),
  gcIdleTimeoutMs: gcIdleTimeoutMs(),
};

export function notesName(): string {
  return path.basename(config.notesDir);
}

/** Idle General Chat reap timeout: GC_IDLE_TIMEOUT_MS, default 1h. Zero or
 *  negative disables the reaper (dashboards that prefer manual cleanup). */
function gcIdleTimeoutMs(): number {
  const raw = process.env.GC_IDLE_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return 3_600_000;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 3_600_000;
}

const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Validate a bare project name and resolve it to its host directory. */
export function projectDir(name: string): string | null {
  if (name === notesName()) return config.notesDir;
  if (!PROJECT_NAME_RE.test(name) || name === "." || name === "..") return null;
  return path.join(config.projectsDir, name);
}

/**
 * Validate an absolute host directory for bare-metal pi agents
 * (see docs/host-pi.md). Resolves symlinks and confines the result to the
 * dev home dir. In `MOCK_VPS=1` the home prefix check is skipped so the
 * mock fixtures (outside /home/dev) stay drivable offline.
 *
 * Returns the real path, or null when invalid/nonexistent/not-a-directory.
 */
export async function resolveHostDir(input: string): Promise<string | null> {
  const trimmed = (input ?? "").trim();
  if (!trimmed || !path.isAbsolute(trimmed)) return null;
  const resolved = path.resolve(trimmed);
  let real: string;
  try {
    real = await import("node:fs").then((fs) => fs.promises.realpath(resolved));
  } catch {
    return null; // nonexistent (no autocreate for host dirs — explicit choice)
  }
  try {
    const st = await import("node:fs").then((fs) => fs.promises.stat(real));
    if (!st.isDirectory()) return null;
  } catch {
    return null;
  }
  if (process.env.MOCK_VPS === "1") return real;
  let homeReal: string;
  try {
    homeReal = await import("node:fs").then((fs) => fs.promises.realpath(config.homeDir));
  } catch {
    homeReal = path.resolve(config.homeDir);
  }
  if (real !== homeReal && !real.startsWith(homeReal + path.sep)) return null;
  return real;
}
