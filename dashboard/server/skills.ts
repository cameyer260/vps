import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

/**
 * Skill listing for the chat composer's "/" autocomplete: walks the agent
 * skills directory (mounted read-only into the dashboard container, same
 * source the agents load skills from) and pulls name + one-line description
 * out of each SKILL.md's YAML frontmatter. The chat inserts them as
 * `/skill:<name>` — pi expands skill commands on prompt.
 */

export interface SkillInfo {
  name: string;
  description: string;
  path: string; // skills-dir-relative, for debugging
}

const SKIP_DIRS = new Set([".git", "node_modules", ".trash", ".obsidian"]);
const MAX_DEPTH = 3;
const MAX_DESCRIPTION = 160;

export function parseSkillFrontmatter(raw: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!m) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of m[1]!.split("\n")) {
    const kv = /^(name|description):\s*(.*)\s*$/.exec(line);
    if (!kv) continue;
    const value = kv[2]!.replace(/^["']|["']$/g, "").trim();
    if (kv[1] === "name" && value) out.name = value;
    if (kv[1] === "description" && value) out.description = value;
  }
  return out;
}

function oneLine(s: string | undefined): string {
  if (!s) return "";
  return s.replace(/\s+/g, " ").trim().slice(0, MAX_DESCRIPTION);
}

export async function listSkills(): Promise<SkillInfo[]> {
  const root = config.skillsDir;
  const byName = new Map<string, SkillInfo>();

  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // A dir is a skill when it directly contains SKILL.md.
    const hasSkillMd = entries.some((e) => e.isFile() && e.name === "SKILL.md");
    if (hasSkillMd) {
      try {
        const raw = await fsp.readFile(path.join(dir, "SKILL.md"), "utf8");
        const fm = parseSkillFrontmatter(raw);
        const dirName = path.basename(dir);
        const name = fm.name ?? dirName;
        if (name && !byName.has(name)) {
          byName.set(name, {
            name,
            description: oneLine(fm.description),
            path: rel,
          });
        }
      } catch {
        // unreadable SKILL.md — skip
      }
      return; // don't descend into a skill dir
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) {
        // skills dirs may be symlinks into packages (they are on this VPS)
        isDir = (
          await fsp.stat(path.join(dir, e.name)).then((s) => s.isDirectory()).catch(() => false)
        );
      }
      if (isDir) {
        await walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
      }
    }
  }

  await walk(root, "", 0);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
