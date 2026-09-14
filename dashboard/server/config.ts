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
