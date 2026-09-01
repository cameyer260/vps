import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { TreeNode } from "../types";
import { CopyButton } from "./CopyButton";
import { Markdown } from "./MessageView";

/**
 * Notes viewer — an Obsidian clone over /home/dev/notes.
 *
 * Multiple files open at once (tabs), rendered markdown vs raw edit toggle,
 * full-text search. Edits auto-save to disk (debounced) and every file edited
 * in this viewer session is staged by the "commit & push" button — so dirt
 * from agents isn't swept up. Opening the viewer does a host-side git pull.
 */

interface Tab {
  path: string;
  content: string; // current editor content
  saved: string; // last written content
  raw: boolean;
}

export function NotesViewer({ notesName, onBack }: { notesName: string; onBack: () => void }) {
  const [tree, setTree] = useState<TreeNode[] | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [edited, setEdited] = useState<Set<string>>(new Set());
  const [pullError, setPullError] = useState<string | null>(null);
  const [treeOpen, setTreeOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);

  const loadTree = useCallback(() => {
    api
      .notesTree()
      .then((r) => setTree(r.tree))
      .catch((e) => setPullError(String((e as Error).message ?? e)));
  }, []);

  // On open: host-side git pull (errors surfaced with copy-to-clipboard).
  useEffect(() => {
    api
      .gitPull(notesName)
      .then((r) => {
        if (!r.ok) setPullError(r.output || "git pull failed");
      })
      .catch((e) => setPullError(String((e as Error).message ?? e)));
    loadTree();
  }, [notesName, loadTree]);

  const openFile = async (path: string) => {
    setTreeOpen(false);
    const existing = tabs.find((t) => t.path === path);
    if (existing) {
      setActive(path);
      return;
    }
    try {
      const file = await api.notesFile(path);
      setTabs((ts) => [...ts, { path, content: file.content, saved: file.content, raw: false }]);
      setActive(path);
    } catch (e) {
      setPullError(String((e as Error).message ?? e));
    }
  };

  const updateTab = (path: string, content: string) => {
    setTabs((ts) => ts.map((t) => (t.path === path ? { ...t, content } : t)));
    setEdited((s) => {
      if (s.has(path)) return s;
      const next = new Set(s);
      next.add(path);
      return next;
    });
  };

  const closeTab = (path: string) => {
    setTabs((ts) => ts.filter((t) => t.path !== path));
    setActive((cur) => (cur === path ? (tabs.find((t) => t.path !== path)?.path ?? null) : cur));
  };

  const activeTab = tabs.find((t) => t.path === active) ?? null;
  const activeDirty = activeTab ? activeTab.content !== activeTab.saved : false;

  return (
    <div className="notes">
      <header className="notes-head">
        <button className="btn ghost back" onClick={onBack} aria-label="Back">
          ←
        </button>
        <button className="btn ghost tree-btn" onClick={() => setTreeOpen(true)} aria-label="Files">
          ☰
        </button>
        <span className="notes-title">📝 {notesName}</span>
        <button className="btn ghost" onClick={() => setSearchOpen(true)}>
          🔍 search
        </button>
        <button
          className="btn primary"
          onClick={() => setCommitOpen(true)}
          disabled={edited.size === 0}
          title="Stage every file edited in this viewer session, commit, push"
        >
          commit &amp; push{edited.size > 0 ? ` (${edited.size})` : ""}
        </button>
      </header>

      {pullError && (
        <div className="git-banner">
          <div className="git-banner-head">
            <span>git pull failed (host-side)</span>
            <span className="banner-actions">
              <CopyButton text={pullError} />
              <button
                className="btn small"
                onClick={() =>
                  api
                    .gitPull(notesName)
                    .then((r) => (r.ok ? setPullError(null) : setPullError(r.output)))
                }
              >
                retry
              </button>
              <button className="btn small ghost" onClick={() => setPullError(null)}>
                dismiss
              </button>
            </span>
          </div>
          <pre className="porcelain">{pullError}</pre>
        </div>
      )}

      <div className="notes-body">
        <div className={`notes-tree${treeOpen ? " open" : ""}`}>
          <div className="notes-tree-head">
            <span>files</span>
            <button className="btn small ghost" onClick={() => setTreeOpen(false)}>
              close
            </button>
          </div>
          {tree === null ? (
            <div className="dim pad">loading…</div>
          ) : (
            <Tree nodes={tree} depth={0} onOpen={openFile} active={active} />
          )}
        </div>
        {treeOpen && <div className="scrim" onClick={() => setTreeOpen(false)} />}

        <div className="notes-main">
          {tabs.length === 0 ? (
            <div className="empty">
              <p>Open a note from the file tree.</p>
              <p className="dim">
                Edited files are saved as you type; “commit &amp; push” stages everything
                edited in this session.
              </p>
            </div>
          ) : (
            <>
              <div className="tab-bar">
                {tabs.map((t) => (
                  <span
                    key={t.path}
                    className={`tab${t.path === active ? " active" : ""}`}
                    onClick={() => setActive(t.path)}
                  >
                    {t.path.split("/").pop()}
                    {t.content !== t.saved && " •"}
                    <button className="tab-close" onClick={() => closeTab(t.path)}>
                      ×
                    </button>
                  </span>
                ))}
              </div>
              {activeTab && (
                <div className="note-view">
                  <div className="note-toolbar">
                    <span className="dim note-path">{activeTab.path}</span>
                    <span className="banner-actions">
                      {activeDirty && <span className="dim">unsaved…</span>}
                      <button
                        className={`btn small${activeTab.raw ? "" : " primary"}`}
                        onClick={() =>
                          setTabs((ts) =>
                            ts.map((t) =>
                              t.path === activeTab.path ? { ...t, raw: false } : t,
                            ),
                          )
                        }
                      >
                        rendered
                      </button>
                      <button
                        className={`btn small${activeTab.raw ? " primary" : ""}`}
                        onClick={() =>
                          setTabs((ts) =>
                            ts.map((t) =>
                              t.path === activeTab.path ? { ...t, raw: true } : t,
                            ),
                          )
                        }
                      >
                        raw edit
                      </button>
                    </span>
                  </div>
                  {activeTab.raw ? (
                    <RawEditor tab={activeTab} onChange={updateTab} />
                  ) : (
                    <div className="note-render">
                      <Markdown>{activeTab.content || "*(empty note)*"}</Markdown>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {searchOpen && (
        <SearchPanel
          onClose={() => setSearchOpen(false)}
          onOpen={openFile}
        />
      )}

      {commitOpen && (
        <CommitDialog
          edited={[...edited]}
          onClose={() => setCommitOpen(false)}
          onCommitted={() => {
            setEdited(new Set());
            setCommitOpen(false);
            loadTree();
          }}
        />
      )}
    </div>
  );
}

/** Debounced raw editor: writes through to disk as you type. */
function RawEditor({
  tab,
  onChange,
}: {
  tab: Tab;
  onChange: (path: string, content: string) => void;
}) {
  const [text, setText] = useState(tab.content);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(text);

  // Resync only when switching between files; live edits flow back through
  // onChange so resetting on tab.content would clobber the status display.
  useEffect(() => {
    setText(tab.content);
    setStatus("idle");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.path]);

  const handleChange = (v: string) => {
    setText(v);
    latest.current = v;
    onChange(tab.path, v);
    setStatus("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      api
        .notesWrite(tab.path, latest.current)
        .then(() => setStatus("saved"))
        .catch(() => setStatus("error"));
    }, 600);
  };

  return (
    <div className="raw-editor">
      <textarea
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        spellCheck={false}
      />
      <div className="raw-status dim">
        {status === "saving" && "saving…"}
        {status === "saved" && "saved ✓"}
        {status === "error" && "save failed"}
      </div>
    </div>
  );
}

function Tree({
  nodes,
  depth,
  onOpen,
  active,
}: {
  nodes: TreeNode[];
  depth: number;
  onOpen: (path: string) => void;
  active: string | null;
}) {
  return (
    <ul className="tree" style={{ paddingLeft: depth === 0 ? 6 : 14 }}>
      {nodes.map((n) =>
        n.type === "dir" ? (
          <li key={n.path}>
            <details open={depth === 0}>
              <summary className="tree-dir">{n.name}</summary>
              {n.children && (
                <Tree nodes={n.children} depth={depth + 1} onOpen={onOpen} active={active} />
              )}
            </details>
          </li>
        ) : (
          <li key={n.path}>
            <button
              className={`tree-file${active === n.path ? " current" : ""}`}
              onClick={() => onOpen(n.path)}
            >
              {n.name}
            </button>
          </li>
        ),
      )}
    </ul>
  );
}

function SearchPanel({
  onClose,
  onOpen,
}: {
  onClose: () => void;
  onOpen: (path: string) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ path: string; line: number; text: string }[] | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const r = await api.notesSearch(q);
      setResults(r.results);
    } catch {
      setResults([]);
    }
    setBusy(false);
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Search notes</h2>
        <div className="search-row">
          <input
            className="input"
            autoFocus
            placeholder="search all notes…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()}
          />
          <button className="btn primary" onClick={run} disabled={busy}>
            {busy ? "…" : "search"}
          </button>
        </div>
        <div className="search-results">
          {results?.length === 0 && <div className="dim pad">no matches</div>}
          {results?.map((h, i) => (
            <button
              key={`${h.path}:${h.line}:${i}`}
              className="search-hit"
              onClick={() => {
                onOpen(h.path);
                onClose();
              }}
            >
              <span className="search-hit-path">{h.path}</span>
              <span className="search-hit-text">{h.text}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function CommitDialog({
  edited,
  onClose,
  onCommitted,
}: {
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
      const r = await api.notesCommit(edited, message);
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
          onKeyDown={(e) => e.key === "Enter" && !busy && commit()}
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
          <button className="btn primary" onClick={commit} disabled={busy}>
            {busy ? "pushing…" : "commit & push"}
          </button>
        </div>
      </div>
    </div>
  );
}
