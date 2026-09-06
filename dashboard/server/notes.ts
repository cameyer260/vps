import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

// Notes viewer file operations over /home/dev/notes. Markdown + CSV (the
// CSVs get the spreadsheet-style editor). Paths relative to the notes root
// and validated against traversal.

const MD_EXT = /\.md$/i;
const CSV_EXT = /\.csv$/i;
const EDITABLE_EXT = /\.(md|csv)$/i;
const SKIP_DIRS = new Set([".git", "node_modules", ".obsidian", ".trash"]);
const MAX_FILE_BYTES = 2 << 20; // 2 MiB per file
const MAX_SEARCH_RESULTS = 120;

export interface TreeNode {
  name: string;
  path: string; // relative to notes root, "/"-separated
  type: "dir" | "file";
  children?: TreeNode[];
  size?: number;
  mtime?: number;
}

function safeResolve(rel: string): string | null {
  if (typeof rel !== "string" || rel.length === 0 || rel.includes("\0")) return null;
  const abs = path.resolve(config.notesDir, rel);
  const r = path.relative(config.notesDir, abs);
  if (r.startsWith("..") || path.isAbsolute(r)) return null;
  return abs;
}

export async function notesTree(): Promise<TreeNode[]> {
  async function walk(dir: string, rel: string): Promise<TreeNode[]> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const nodes: TreeNode[] = [];
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const childAbs = path.join(dir, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        nodes.push({
          name: e.name,
          path: childRel,
          type: "dir",
          children: await walk(childAbs, childRel),
        });
      } else if (e.isFile() && EDITABLE_EXT.test(e.name)) {
        const st = await fsp.stat(childAbs).catch(() => null);
        nodes.push({
          name: e.name.replace(MD_EXT, "").replace(CSV_EXT, ""),
          path: childRel,
          type: "file",
          size: st?.size,
          mtime: st?.mtimeMs,
        });
      }
    }
    nodes.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
    );
    return nodes;
  }
  return walk(config.notesDir, "");
}

export interface NoteFile {
  path: string;
  content: string;
  mtime: number;
  size: number;
}

export async function readNote(rel: string): Promise<NoteFile | null> {
  if (!EDITABLE_EXT.test(rel)) return null;
  const abs = safeResolve(rel);
  if (!abs) return null;
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isFile()) return null;
  const content = await fsp.readFile(abs, "utf8");
  return { path: rel, content, mtime: st.mtimeMs, size: st.size };
}

export async function writeNote(rel: string, content: string): Promise<number | null> {
  if (!EDITABLE_EXT.test(rel)) return null;
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
    return null;
  }
  const abs = safeResolve(rel);
  if (!abs) return null;
  await fsp.writeFile(abs, content, "utf8");
  const st = await fsp.stat(abs);
  return st.mtimeMs;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export async function searchNotes(query: string): Promise<SearchHit[]> {
  const q = query.toLowerCase();
  if (q.trim().length < 2) return [];
  const hits: SearchHit[] = [];

  async function walk(dir: string, rel: string): Promise<void> {
    if (hits.length >= MAX_SEARCH_RESULTS) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (hits.length >= MAX_SEARCH_RESULTS) return;
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const childAbs = path.join(dir, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(childAbs, childRel);
      } else if (e.isFile() && EDITABLE_EXT.test(e.name) && e.name) {
        let stat;
        try {
          stat = await fsp.stat(childAbs);
          if (stat.size > MAX_FILE_BYTES) continue;
          const content = await fsp.readFile(childAbs, "utf8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(q)) {
              hits.push({
                path: childRel,
                line: i + 1,
                text: lines[i].trim().slice(0, 200),
              });
              if (hits.length >= MAX_SEARCH_RESULTS) return;
            }
          }
        } catch {
          continue;
        }
      }
    }
  }

  await walk(config.notesDir, "");
  return hits;
}
