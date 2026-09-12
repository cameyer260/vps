import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { TreeNode } from "../types";
import { CopyButton } from "./CopyButton";
import { MarkdownEditor } from "./MarkdownEditor";
import { CsvEditor } from "./CsvEditor";
import { CodePane } from "./CodePane";
import { EditToggle } from "./EditToggle";
import { TreeModal, type TreeModalItem } from "./TreeModal";

/**
 * IDE tab (spec §5): notes-first file editor over whichever project is
 * selected — same project source as everywhere (`GET /api/projects`), file
 * tree/read/write/search generalized from the notes dir to the selected
 * project root (phase 4 `/api/files/*`, same traversal guards).
 *
 * No-selection state: `Dashboard - IDE` (global chrome) + a right-aligned
 * project button (`Select` until chosen) + `No IDE Selected, Pick one` with
 * a `Select` button opening the project-picker modal (search input on top,
 * scrollable notes+projects list, type-to-filter, tap selects the root).
 *
 * Project state, sub-header left-to-right per the sketch: file-tree button
 * (opens the tree modal sliding from the left; folders expand/collapse, tap
 * a file to open + close) → path/breadcrumb → search button (search modal
 * over files in the project dir) → pencil `EditToggle` (default
 * read-only) — plus the project button and commit & push. Body renders one
 * open file at a time (no multi-file tabs): md = live-preview editor,
 * csv = grid, other text = monospace + line numbers, binary = "not shown".
 * All editing goes through the toggle; autosave + session-scoped commit &
 * push are unchanged from the old viewer.
 */

const IDE_PROJECT_KEY = "ide.project";

type FileKind = "md" | "csv" | "text" | "binary";

export function IdeView({ homeSignal }: { homeSignal: number }) {
  const [projects, setProjects] = useState<string[]>([]);
  const [notesName, setNotesName] = useState("notes");
  const [project, setProject] = useState<string | null>(() => {
    try {
      return localStorage.getItem(IDE_PROJECT_KEY);
    } catch {
      return null;
    }
  });
  const [tree, setTree] = useState<TreeNode[] | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [kind, setKind] = useState<FileKind | null>(null);
  const [content, setContent] = useState("");
  const [saved, setSaved] = useState("");
  const [loadingFile, setLoadingFile] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [edited, setEdited] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState(false); // default read-only
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerFilter, setPickerFilter] = useState("");
  const [treeOpen, setTreeOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const openReq = useRef(0);

  // Same project source as everywhere else.
  useEffect(() => {
    api
      .projects()
      .then((r) => {
        setProjects(r.projects);
        setNotesName(r.notes);
        // A persisted project that no longer exists drops to no-selection.
        setProject((cur) => {
          if (cur && cur !== r.notes && !r.projects.includes(cur)) {
            try {
              localStorage.removeItem(IDE_PROJECT_KEY);
            } catch {
              /* private mode */
            }
            return null;
          }
          return cur;
        });
      })
      .catch(() => {});
  }, []);

  const loadTree = useCallback((p: string) => {
    setTree(null);
    api
      .filesTree(p)
      .then((r) => setTree(r.tree))
      .catch((e) => setLoadError(String((e as Error).message ?? e)));
  }, []);

  useEffect(() => {
    if (project) loadTree(project);
    else setTree(null);
  }, [project, loadTree]);

  const resetFile = useCallback(() => {
    openReq.current++;
    setOpenPath(null);
    setKind(null);
    setContent("");
    setSaved("");
    setLoadingFile(false);
    setFileError(null);
    setEditing(false);
  }, []);

  const goNoSelection = useCallback(() => {
    try {
      localStorage.removeItem(IDE_PROJECT_KEY);
    } catch {
      /* private mode */
    }
    setProject(null);
    setEdited(new Set());
    setLoadError(null);
    setPickerOpen(false);
    setTreeOpen(false);
    setSearchOpen(false);
    setCommitOpen(false);
    resetFile();
  }, [resetFile]);

  // Tapping `Dashboard` in the header homes *within* the IDE tab: back to
  // the no-selection state (spec §2). Tab switches unmount/remount and keep
  // the persisted project — only an explicit home clears it. The prev-value
  // guard (not a first-run ref) keeps this a no-op on mount, including
  // StrictMode's double-invoked mount effects.
  const prevHome = useRef(homeSignal);
  useEffect(() => {
    if (prevHome.current === homeSignal) return;
    prevHome.current = homeSignal;
    goNoSelection();
  }, [homeSignal, goNoSelection]);

  const selectProject = (p: string) => {
    try {
      localStorage.setItem(IDE_PROJECT_KEY, p);
    } catch {
      /* private mode */
    }
    setProject(p);
    setEdited(new Set());
    setLoadError(null);
    setPickerOpen(false);
    setPickerFilter("");
    resetFile();
  };

  const openFile = async (path: string) => {
    if (!project) return;
    const proj = project;
    setTreeOpen(false);
    setSearchOpen(false);
    setFileError(null);
    setOpenPath(path);
    setKind(null);
    setLoadingFile(true);
    // Editing always starts read-only per file (spec §5.2 default).
    setEditing(false);
    const req = ++openReq.current;
    try {
      const file = await api.filesFile(proj, path);
      if (openReq.current !== req) return; // superseded by a newer open
      // The live-preview markdown editor serializes without a trailing
      // newline, so loading the raw text as-is would fire its onUpdate on
      // mount and phantom-dirty the file. Pre-trim trailing newlines (the
      // editor produces this form on the first real save anyway).
      const text = file.kind === "md" ? file.content.replace(/\n+$/, "") : file.content;
      setKind(file.kind as FileKind);
      setContent(text);
      setSaved(text);
    } catch (e) {
      if (openReq.current !== req) return;
      if (e instanceof ApiError && e.status === 415) {
        setKind("binary");
        setContent("");
        setSaved("");
      } else if (e instanceof ApiError && e.status === 413) {
        setFileError(`file too large (max 2 MiB): ${path}`);
      } else {
        setFileError(`couldn't open ${path}: ${String((e as Error).message ?? e)}`);
      }
    } finally {
      if (openReq.current === req) setLoadingFile(false);
    }
  };

  const changeFile = (next: string) => {
    if (!openPath) return;
    const p = openPath;
    setContent(next);
    setEdited((s) => {
      if (s.has(p)) return s;
      const nextSet = new Set(s);
      nextSet.add(p);
      return nextSet;
    });
  };

  const reportSaved = (path: string, text: string) => {
    // Only the currently open file tracks dirty state (single-file view).
    if (path === openPathRef.current) setSaved(text);
  };
  const openPathRef = useRef(openPath);
  openPathRef.current = openPath;

  const crumbText = !project
    ? "No project"
    : openPath
      ? `${project} / ${openPath}`
      : project;

  const allProjects = [notesName, ...projects.filter((p) => p !== notesName)];
  const pickerItems: TreeModalItem[] = allProjects
    .filter((p) => p.toLowerCase().includes(pickerFilter.trim().toLowerCase()))
    .map((p) => ({
      key: p,
      title: p,
      subtitle: p === notesName ? "notes" : undefined,
    }));

  const treeItems: TreeModalItem[] = tree ? toTreeItems(tree, 0) : [];

  /** Dir rows expand in place; only file taps open (empty dirs no-op). */
  const selectTreeRow = (item: TreeModalItem) => {
    if (!tree) return;
    const node = findNode(tree, item.key);
    if (!node || node.type === "dir") return;
    void openFile(item.key);
  };

  const dirty = content !== saved;
  const editableOpen = !!project && !!openPath && kind !== null && kind !== "binary";

  return (
    <div className="notes ide">
      <header className="notes-head ide-head">
        <button
          className="btn ghost tree-btn"
          onClick={() => setTreeOpen(true)}
          disabled={!project}
          aria-label="Files"
          title={project ? `Files — ${project}` : "Pick a project first"}
        >
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M9 4v16" />
          </svg>
        </button>
        <span className="notes-title" title={crumbText}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
            <path d="M14 3v5h5" />
          </svg>
          {crumbText}
        </span>
        <button
          className="btn ghost"
          onClick={() => setSearchOpen(true)}
          disabled={!project}
          aria-label="Search files"
          title={project ? `Search files — ${project}` : "Pick a project first"}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 4 }}>
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <span className="ide-search-label">search</span>
        </button>
        {project && (
          <EditToggle
            editing={editing}
            onChange={setEditing}
            disabled={!editableOpen || loadingFile}
          />
        )}
        <button
          className="btn primary"
          onClick={() => setCommitOpen(true)}
          disabled={!project || edited.size === 0}
          title="Stage every file edited in this viewer session, commit, push"
        >
          commit &amp; push{edited.size > 0 ? ` (${edited.size})` : ""}
        </button>
        <button
          className="btn small ide-project-btn"
          onClick={() => {
            setPickerFilter("");
            setPickerOpen(true);
          }}
          title="IDE project — tap to change"
        >
          {project ?? "Select"}
        </button>
      </header>

      {loadError && (
        <div className="git-banner">
          <div className="git-banner-head">
            <span>failed to load files</span>
            <span className="banner-actions">
              <CopyButton text={loadError} />
              <button
                className="btn small"
                onClick={() => {
                  setLoadError(null);
                  if (project) loadTree(project);
                }}
              >
                retry
              </button>
              <button className="btn small ghost" onClick={() => setLoadError(null)}>
                dismiss
              </button>
            </span>
          </div>
          <pre className="porcelain">{loadError}</pre>
        </div>
      )}

      <div className="notes-body">
        <div className="notes-main">
          {!project ? (
            <div className="empty">
              <p>No IDE Selected, Pick one</p>
              <button
                className="btn primary"
                onClick={() => {
                  setPickerFilter("");
                  setPickerOpen(true);
                }}
              >
                Select
              </button>
            </div>
          ) : !openPath ? (
            <div className="empty">
              {tree === null ? (
                <p className="dim">loading…</p>
              ) : (
                <>
                  <p>Open a file from the file tree.</p>
                  <p className="dim">
                    Edited files are saved as you type; “commit &amp; push” stages everything
                    edited in this session.
                  </p>
                  <button className="btn" onClick={() => setTreeOpen(true)}>
                    Files
                  </button>
                </>
              )}
            </div>
          ) : (
            <div className="note-view">
              <div className="note-toolbar">
                <span className="dim note-path">{openPath}</span>
                <span className="banner-actions">
                  {dirty && !loadingFile && <span className="dim">unsaved…</span>}
                </span>
              </div>
              {loadingFile || kind === null ? (
                <div className="empty">
                  {fileError ? (
                    <>
                      <p>{fileError}</p>
                      <button className="btn" onClick={() => setTreeOpen(true)}>
                        Files
                      </button>
                    </>
                  ) : (
                    <p className="dim">loading…</p>
                  )}
                </div>
              ) : kind === "binary" ? (
                <div className="empty">
                  <p>{openPath}</p>
                  <p className="dim">not shown</p>
                </div>
              ) : kind === "md" ? (
                <MarkdownEditor
                  key={`${project}:${openPath}`}
                  project={project}
                  path={openPath}
                  content={content}
                  editing={editing}
                  onChange={changeFile}
                  onSaved={(text) => reportSaved(openPath, text)}
                />
              ) : kind === "csv" ? (
                <CsvEditor
                  key={`${project}:${openPath}`}
                  project={project}
                  path={openPath}
                  content={content}
                  editing={editing}
                  onChange={changeFile}
                  onSaved={(text) => reportSaved(openPath, text)}
                />
              ) : (
                <CodePane
                  key={`${project}:${openPath}`}
                  project={project}
                  path={openPath}
                  content={content}
                  editing={editing}
                  onChange={changeFile}
                  onSaved={(text) => reportSaved(openPath, text)}
                />
              )}
            </div>
          )}
        </div>
      </div>

      {pickerOpen && (
        <TreeModal
          title="Select project"
          items={pickerItems}
          emptyText="no matching projects"
          search={{
            value: pickerFilter,
            onChange: setPickerFilter,
            placeholder: "Filter projects…",
          }}
          onClose={() => setPickerOpen(false)}
          onSelect={(item) => selectProject(item.key)}
        />
      )}

      {treeOpen && project && (
        <TreeModal
          title={`Files — ${project}`}
          items={treeItems}
          emptyText={tree === null ? "loading…" : "no files"}
          variant="left"
          onClose={() => setTreeOpen(false)}
          onSelect={selectTreeRow}
        />
      )}

      {searchOpen && project && (
        <IdeSearch project={project} onClose={() => setSearchOpen(false)} onOpen={openFile} />
      )}

      {commitOpen && project && (
        <CommitDialog
          project={project}
          edited={[...edited]}
          onClose={() => setCommitOpen(false)}
          onCommitted={() => {
            setEdited(new Set());
            setSaved(content);
            setCommitOpen(false);
            loadTree(project);
          }}
        />
      )}
    </div>
  );
}

function toTreeItems(nodes: TreeNode[], depth: number): TreeModalItem[] {
  return nodes.map((n) =>
    n.type === "dir"
      ? {
          key: n.path,
          title: n.name,
          children: toTreeItems(n.children ?? [], depth + 1),
          defaultExpanded: depth === 0,
        }
      : {
          key: n.path,
          title: n.name,
          subtitle: n.kind && n.kind !== "md" ? n.kind : undefined,
        },
  );
}

function findNode(nodes: TreeNode[], path: string): TreeNode | null {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.children) {
      const found = findNode(n.children, path);
      if (found) return found;
    }
  }
  return null;
}

function IdeSearch({
  project,
  onClose,
  onOpen,
}: {
  project: string;
  onClose: () => void;
  onOpen: (path: string) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ path: string; line: number; text: string }[] | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (q.trim().length < 2) return;
    setBusy(true);
    try {
      const r = await api.filesSearch(project, q);
      setResults(r.results);
    } catch {
      setResults([]);
    }
    setBusy(false);
  };

  return (
    <TreeModal
      title={`Search — ${project}`}
      items={(results ?? []).map((h) => ({
        key: `${h.path}:${h.line}`,
        title: h.path,
        subtitle: `L${h.line}: ${h.text}`,
      }))}
      search={{ value: q, onChange: setQ, placeholder: "Search files… (min 2 chars)" }}
      emptyText={results === null ? "Type and hit Search" : "no matches"}
      footer={
        <div className="ide-search-foot">
          {busy && <span className="dim">searching…</span>}
          <button
            className="btn primary"
            onClick={() => void run()}
            disabled={busy || q.trim().length < 2}
          >
            {busy ? "…" : "Search"}
          </button>
        </div>
      }
      onClose={onClose}
      onSelect={(item) => {
        // path+line is unique within a result set (one hit per matching
        // line), so look the hit up instead of trusting an array index.
        const hit = results?.find((h) => `${h.path}:${h.line}` === item.key);
        if (hit) void onOpen(hit.path);
      }}
    />
  );
}

function CommitDialog({
  project,
  edited,
  onClose,
  onCommitted,
}: {
  project: string;
  edited: string[];
  onClose: () => void;
  onCommitted: () => void;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; output: string } | null>(null);

  const commit = async () => {
    setBusy(true);
    try {
      const r = await api.filesCommit(project, edited, message);
      setResult(r);
      if (r.ok) {
        setTimeout(onCommitted, 800);
        return;
      }
    } catch (e) {
      setResult({ ok: false, output: String((e as Error).message ?? e) });
    }
    setBusy(false);
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Commit &amp; push {edited.length} file{edited.length === 1 ? "" : "s"}</h2>
        <ul className="commit-files">
          {edited.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
        <label className="field-label">Commit message</label>
        <input
          className="input"
          autoFocus
          placeholder="what changed?"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !busy && void commit()}
        />
        {result && !result.ok && (
          <div className="error-box">
            <div className="error-head">
              <span>git failed</span>
              <CopyButton text={result.output} />
            </div>
            <pre className="porcelain">{result.output}</pre>
          </div>
        )}
        {result?.ok && <div className="dim pad">pushed ✓</div>}
        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            cancel
          </button>
          <button className="btn primary" onClick={() => void commit()} disabled={busy}>
            {busy ? "pushing…" : "commit & push"}
          </button>
        </div>
      </div>
    </div>
  );
}
