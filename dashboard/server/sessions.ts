import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export interface SessionSummary {
  /** Absolute path — pass to jarvis rpc --session to resume. */
  file: string;
  id: string;
  name: string | null;
  timestamp: string | null;
  mtime: number;
  preview: string | null; // first user message, truncated
}

interface Raw {
  type?: string;
  id?: string;
  timestamp?: string;
  cwd?: string;
  message?: { role?: string; content?: unknown };
  name?: string;
}

/**
 * List pi sessions whose working directory matches `dir`.
 *
 * Sessions live at <sessionsDir>/--<cwd-with-slashes-as-dashes>--/<ts>_<id>.jsonl.
 * Rather than trusting the directory-name mapping we parse each file's header
 * line and match on its `cwd` — robust against layout changes.
 */
export async function listSessions(dir: string): Promise<SessionSummary[]> {
  const out: SessionSummary[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(config.sessionsDir, { withFileTypes: true });
  } catch {
    return out; // sessions dir not mounted/created yet
  }

  await Promise.all(
    entries.map(async (e) => {
      if (!e.isDirectory()) return;
      const subdir = path.join(config.sessionsDir, e.name);
      let files: fs.Dirent[];
      try {
        files = await fs.promises.readdir(subdir, { withFileTypes: true });
      } catch {
        return;
      }
      await Promise.all(
        files.map(async (f) => {
          if (!f.isFile() || !f.name.endsWith(".jsonl")) return;
          const file = path.join(subdir, f.name);
          const summary = await summarize(file);
          if (summary && summary.cwd === dir) {
            out.push({
              file,
              id: summary.id ?? f.name.replace(/\.jsonl$/, ""),
              name: summary.name ?? null,
              timestamp: summary.timestamp ?? null,
              mtime: summary.mtime,
              preview: summary.preview,
            });
          }
        }),
      );
    }),
  );

  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

async function summarize(
  file: string,
): Promise<(Omit<SessionSummary, "file" | "id"> & { id?: string; cwd?: string }) | null> {
  const lines = await readHeadLines(file, 400);
  if (lines.length === 0) return null;
  let header: Raw;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    return null;
  }
  if (header.type !== "session") return null;

  let name: string | null = null;
  let preview: string | null = null;
  for (const line of lines.slice(1)) {
    let entry: Raw;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    // First session_info wins: it's the spawn-time name (user-supplied or
    // pi's initial title). Later auto-generated session_info renames must
    // not mask what the conversation was created as.
    if (!name && entry.type === "session_info" && entry.name) name = entry.name;
    if (!preview && entry.type === "message" && entry.message?.role === "user") {
      preview = truncate(messageText(entry.message.content), 140);
    }
    if (name && preview) break;
  }

  let mtime = 0;
  try {
    mtime = (await fs.promises.stat(file)).mtimeMs;
  } catch {
    /* ignore */
  }
  return {
    id: header.id,
    cwd: header.cwd,
    name,
    timestamp: header.timestamp ?? null,
    mtime,
    preview,
  };
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text?: string } => typeof b === "object" && b !== null)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join(" ");
  }
  return "";
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

/**
 * Read the first `maxLines` JSONL lines. Splits on LF only (pi session files
 * are JSONL; generic line readers also split on U+2028/9 inside JSON strings).
 */
async function readHeadLines(file: string, maxLines: number): Promise<string[]> {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const lines: string[] = [];
  let buf = "";
  try {
    for await (const chunk of stream) {
      buf += chunk as string;
      for (;;) {
        const idx = buf.indexOf("\n");
        if (idx === -1) break;
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        if (line) lines.push(line);
        if (lines.length >= maxLines) {
          stream.destroy();
          return lines;
        }
      }
    }
    if (buf && lines.length < maxLines) lines.push(buf.replace(/\r$/, ""));
  } catch {
    /* unreadable file — skip */
  }
  return lines;
}
