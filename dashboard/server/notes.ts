import { notesName } from "./config.js";
import {
  filterCommitPaths,
  projectTree,
  readProjectFile,
  searchProject,
  writeProjectFile,
  type FileNode,
  type SearchHit,
} from "./files.js";

// Notes-compat aliases over the project-scoped files backend (server/files.ts).
// Behavior is exactly the old notes-only viewer backend: markdown + CSV only,
// dotfiles hidden, display names without the extension. The dashboard UI moved
// to /api/files/* in Phase 5; these aliases stay for the mock-smoke contract
// (which asserts the notes surface) until a later phase decides otherwise.

const MD_EXT = /\.md$/i;
const CSV_EXT = /\.csv$/i;
const EDITABLE_EXT = /\.(md|csv)$/i;

export interface TreeNode {
  name: string;
  path: string; // relative to notes root, "/"-separated
  type: "dir" | "file";
  children?: TreeNode[];
  size?: number;
  mtime?: number;
}

function strip(n: FileNode): TreeNode {
  if (n.type === "dir") {
    return { name: n.name, path: n.path, type: "dir", children: (n.children ?? []).map(strip) };
  }
  return {
    name: n.name.replace(MD_EXT, "").replace(CSV_EXT, ""),
    path: n.path,
    type: "file",
    size: n.size,
    mtime: n.mtime,
  };
}

function filterEditable(nodes: FileNode[]): FileNode[] {
  const out: FileNode[] = [];
  for (const n of nodes) {
    if (n.type === "dir") {
      out.push({ ...n, children: filterEditable(n.children ?? []) });
    } else if (EDITABLE_EXT.test(n.name)) {
      out.push(n);
    }
  }
  return out;
}

export async function notesTree(): Promise<TreeNode[]> {
  const tree = await projectTree(notesName());
  return filterEditable(tree ?? []).map(strip);
}

export interface NoteFile {
  path: string;
  content: string;
  mtime: number;
  size: number;
}

export async function readNote(rel: string): Promise<NoteFile | null> {
  if (!EDITABLE_EXT.test(rel)) return null;
  const r = await readProjectFile(notesName(), rel);
  if (!r.ok) return null;
  return { path: r.file.path, content: r.file.content, mtime: r.file.mtime, size: r.file.size };
}

export async function writeNote(rel: string, content: string): Promise<number | null> {
  if (!EDITABLE_EXT.test(rel)) return null;
  const r = await writeProjectFile(notesName(), rel, content);
  return r.ok ? r.mtime : null;
}

export type { SearchHit };

export async function searchNotes(query: string): Promise<SearchHit[]> {
  // The notes search only ever matched md/csv; the shared backend searches
  // every text kind, so filter back to the old surface.
  const hits = await searchProject(notesName(), query);
  return (hits ?? []).filter((h) => EDITABLE_EXT.test(h.path));
}

/** Valid commit paths for the notes aliases (md/csv, inside notes root). */
export function filterNotePaths(paths: unknown): string[] {
  return filterCommitPaths(notesName(), paths).filter((p) => EDITABLE_EXT.test(p));
}
