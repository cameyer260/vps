import path from "node:path";

// Everything resolvable at deploy time comes from the environment (see
// deploy.sh / the Dockerfile). Defaults match the VPS layout.
export const config = {
  port: Number(process.env.PORT ?? 3000),
  projectsDir: process.env.AGENT_PROJECTS_DIR ?? "/home/dev/projects",
  notesDir: process.env.NOTES_DIR ?? "/home/dev/notes",
  sessionsDir: process.env.PI_SESSIONS_DIR ?? "/home/dev/.pi/agent/sessions",
  jarvisBin: process.env.JARVIS_BIN ?? "/home/dev/vps/agent-images/jarvis.sh",
  wwwDir: process.env.WWW_DIR ?? path.resolve(process.cwd(), "dist"),
};

export function notesName(): string {
  return path.basename(config.notesDir);
}

const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Validate a bare project name and resolve it to its host directory. */
export function projectDir(name: string): string | null {
  if (name === notesName()) return config.notesDir;
  if (!PROJECT_NAME_RE.test(name) || name === "." || name === "..") return null;
  return path.join(config.projectsDir, name);
}
