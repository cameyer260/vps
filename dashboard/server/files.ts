import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { projectDir } from "./config.js";

// Project-scoped file operations for the IDE tab — whichever project is
// selected. Same project source as `GET /api/projects` (projectDir()), same
// traversal guards.
//
// Tree vs search policy (deliberately different): the file tree shows
// EVERYTHING — no name-based skipping, dotfiles included — and marks
// git-ignored paths (`ignored: true`, greyed out client-side, VS Code
// style). Content search instead skips dependency/build/output dirs
// (SEARCH_SKIP_DIRS) so results stay relevant and fast.
//
// File-type policy: markdown + CSV as before, plus every other text/code
// extension the client already treats as text (TEXT_EXT_RE below — keep in
// sync with src/components/ChatView.tsx). Extensionless names (Dockerfile,
// Makefile, .gitignore) count as text. Anything else is binary and reads are
// refused with a `binary: true` signal ("not shown" in the UI).

/** Keep in sync with the client's TEXT_EXT_RE (ChatView.tsx). */
export const TEXT_EXT_RE =
  /\.(md|txt|json|csv|tsv|ya?ml|toml|xml|html?|css|js|jsx|ts|tsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|sh|bash|zsh|sql|ini|cfg|conf|env|log|diff|patch)$/i;
const MD_EXT = /\.md$/i;
const CSV_EXT = /\.csv$/i;
/** Search-only exclusions: dependency, build-output, and tooling dirs that
 *  would drown content search in noise. The file tree ignores nothing. */
const SEARCH_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".obsidian",
  ".trash",
  "dist",
  "build",
  ".next",
  "out",
  "coverage",
  ".nuxt",
  ".output",
  ".vercel",
  ".turbo",
  "__pycache__",
  ".pytest_cache",
  "target",
  "vendor",
  ".venv",
  "venv",
  ".expo",
  ".svelte-kit",
  ".astro",
]);
const MAX_FILE_BYTES = 2 << 20; // 2 MiB per file
const MAX_SEARCH_RESULTS = 120;

export type FileKind = "md" | "csv" | "text" | "binary";

export interface FileNode {
  name: string;
  path: string; // relative to the project root, "/"-separated
  type: "dir" | "file";
  children?: FileNode[];
  kind?: FileKind; // present on files
  /** True when git ignores this path (greyed out in the tree, VS Code style). */
  ignored?: boolean;
  size?: number;
  mtime?: number;
}

export interface FileContent {
  path: string;
  content: string;
  mtime: number;
  size: number;
  kind: FileKind;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

/** Resolve a bare project name to its root dir, or null when invalid. */
export function resolveRoot(project: string): string | null {
  if (typeof project !== "string") return null;
  return projectDir(project);
}

function safeResolve(root: string, rel: string): string | null {
  if (typeof rel !== "string" || rel.length === 0 || rel.includes("\0")) return null;
  const abs = path.resolve(root, rel);
  const r = path.relative(root, abs);
  if (r.startsWith("..") || path.isAbsolute(r)) return null;
  return abs;
}

/** Extension-based kind hint. Unknown extensions read as binary until the
 *  content sniff in readProjectFile proves them text (or refuses them). */
export function kindForName(name: string): FileKind {
  // A leading dot is not an extension (`.gitignore`, `.env` are names, not
  // extensions) — strip it so dotfiles classify as extensionless text.
  // (The NUL-byte sniff in readProjectFile is still the authority: real
  // binaries with text-like names are refused on open regardless.)
  const base = (name.split("/").pop() ?? name).replace(/^\.+/, "");
  if (MD_EXT.test(base)) return "md";
  if (CSV_EXT.test(base)) return "csv";
  if (TEXT_EXT_RE.test(base)) return "text";
  // Extensionless names (Dockerfile, Makefile, .gitignore) are text configs.
  if (!/\.[^/.]+$/.test(base)) return "text";
  return "binary";
}

/** Whether the IDE may write this name (read sniff still gates the open). */
export function isWritableName(name: string): boolean {
  return kindForName(name) !== "binary";
}

export async function projectTree(project: string): Promise<FileNode[] | null> {
  const root = resolveRoot(project);
  if (!root) return null;

  async function walk(dir: string, rel: string): Promise<FileNode[]> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const nodes: FileNode[] = [];
    for (const e of entries) {
      // No name-based skipping: the tree shows everything (dotfiles, .git,
      // build output). Git-ignored paths are marked below, not hidden.
      const childAbs = path.join(dir, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        nodes.push({
          name: e.name,
          path: childRel,
          type: "dir",
          children: await walk(childAbs, childRel),
        });
      } else if (e.isFile()) {
        const st = await fsp.stat(childAbs).catch(() => null);
        nodes.push({
          name: e.name,
          path: childRel,
          type: "file",
          kind: kindForName(e.name),
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

  const tree = await walk(root, "");
  // Grey-out data (VS Code style): one batched `git check-ignore --stdin`
  // over every walked path. Empty when root isn't a repo — plain dirs just
  // show everything unmarked.
  const rels: string[] = [];
  const collect = (nodes: FileNode[]): void => {
    for (const n of nodes) {
      rels.push(n.path);
      if (n.children) collect(n.children);
    }
  };
  collect(tree);
  const ignored = await gitIgnored(root, rels);
  if (ignored.size > 0) markIgnored(tree, ignored);
  return tree;
}

/** Relative paths (as walked) that git ignores under root. One
 *  `check-ignore --stdin` process for the whole tree; stdout is parsed
 *  regardless of exit code (git exits 1 when some paths are NOT ignored).
 *  Empty when root isn't a git repo. */
async function gitIgnored(root: string, rels: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (rels.length === 0) return out;
  // Containment: GIT_CEILING_DIRECTORIES pins discovery inside root — git
  // checks the starting dir itself, and the ceiling (root's parent) blocks
  // ascending from below, so git never sees an enclosing repo. A plain dir
  // (or a subdir of some outer repo) simply reports "not a repo" and shows
  // everything unmarked. Same pin as runCommand (all git ops in git.ts).
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(root) };
  const toplevel = await new Promise<string | null>((resolve) => {
    execFile("git", ["rev-parse", "--show-toplevel"], { cwd: root, env }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout ?? "").trim().split("\n").pop()!.trim() || null);
    });
  });
  if (!toplevel) return out;
  const stdout = await new Promise<string>((resolve) => {
    const child = execFile(
      "git",
      ["-c", "core.quotepath=off", "check-ignore", "--stdin"],
      { cwd: root, env },
      (_err, stdout) => resolve(String(stdout ?? "")),
    );
    child.stdin?.write(rels.join("\n"));
    child.stdin?.end();
  });
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (t) out.add(t);
  }
  return out;
}

/** Flag ignored nodes in place, propagating through ignored dirs (git
 *  reports `dist/` once — everything under it inherits). */
function markIgnored(nodes: FileNode[], ignored: Set<string>, parentIgnored = false): void {
  for (const n of nodes) {
    const self = parentIgnored || ignored.has(n.path);
    if (self) n.ignored = true;
    if (n.children) markIgnored(n.children, ignored, self);
  }
}

export type ReadResult =
  | { ok: true; file: FileContent }
  | { ok: false; reason: "invalid" | "not-found" | "binary" | "oversize"; size?: number };

export async function readProjectFile(project: string, rel: string): Promise<ReadResult> {
  const root = resolveRoot(project);
  if (!root) return { ok: false, reason: "invalid" };
  const abs = safeResolve(root, rel);
  if (!abs) return { ok: false, reason: "invalid" };
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isFile()) return { ok: false, reason: "not-found" };
  if (st.size > MAX_FILE_BYTES) return { ok: false, reason: "oversize", size: st.size };
  let content: string;
  try {
    content = await fsp.readFile(abs, "utf8");
  } catch {
    return { ok: false, reason: "not-found" };
  }
  // Authoritative binary check: any NUL byte means "not shown", whatever the
  // extension claimed (extensionless binaries, misnamed files, real images).
  if (content.includes("\0")) return { ok: false, reason: "binary", size: st.size };
  return {
    ok: true,
    file: { path: rel, content, mtime: st.mtimeMs, size: st.size, kind: kindForName(rel) },
  };
}

export type WriteResult =
  | { ok: true; mtime: number }
  | { ok: false; reason: "invalid" | "binary" | "oversize" };

export async function writeProjectFile(
  project: string,
  rel: string,
  content: string,
): Promise<WriteResult> {
  const root = resolveRoot(project);
  if (!root) return { ok: false, reason: "invalid" };
  if (!isWritableName(rel.split("/").pop() ?? rel)) return { ok: false, reason: "binary" };
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
    return { ok: false, reason: "oversize" };
  }
  const abs = safeResolve(root, rel);
  if (!abs) return { ok: false, reason: "invalid" };
  try {
    await fsp.writeFile(abs, content, "utf8");
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const st = await fsp.stat(abs).catch(() => null);
  return { ok: true, mtime: st?.mtimeMs ?? Date.now() };
}

export async function searchProject(
  project: string,
  query: string,
): Promise<SearchHit[] | null> {
  const root = resolveRoot(project);
  if (!root) return null;
  const q = query.toLowerCase();
  if (q.trim().length < 2) return [];
  const hits: SearchHit[] = [];

  async function walk(dir: string, rel: string): Promise<void> {
    if (hits.length >= MAX_SEARCH_RESULTS) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (hits.length >= MAX_SEARCH_RESULTS) return;
      if (SEARCH_SKIP_DIRS.has(e.name)) continue;
      const childAbs = path.join(dir, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(childAbs, childRel);
      } else if (e.isFile() && isWritableName(e.name)) {
        try {
          const stat = await fsp.stat(childAbs);
          if (stat.size > MAX_FILE_BYTES) continue;
          const content = await fsp.readFile(childAbs, "utf8");
          if (content.includes("\0")) continue;
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

  await walk(root, "");
  return hits;
}

/** Filter commit paths the same way the notes viewer always has: strings
 *  only, inside the project root, writable names. Returns the valid subset. */
export function filterCommitPaths(project: string, paths: unknown): string[] {
  const root = resolveRoot(project);
  if (!root || !Array.isArray(paths)) return [];
  return paths.filter(
    (p): p is string =>
      typeof p === "string" &&
      isWritableName(p.split("/").pop() ?? p) &&
      safeResolve(root, p) !== null,
  );
}
