import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Markdown } from "tiptap-markdown";
import { api } from "../api";

/**
 * Live-preview markdown editor (TipTap/ProseMirror): the document IS the
 * rendered markdown — headings, lists, tables, checkboxes are real rendered
 * elements you edit in place (Obsidian-style). Markdown in (file content),
 * markdown out (debounced PUT to /api/files/file for the IDE project).
 *
 * Keyed by project+path in the parent: one editor instance per open file, so
 * switching files never serializes/deserializes mid-keystroke. Editing is
 * gated by the IDE EditToggle (default read-only) — read-only renders the
 * same document non-editable. `onSaved` reports debounced writes so the
 * parent can track dirty state; the session `edited` set still drives
 * commit & push.
 */
export function MarkdownEditor({
  project,
  path,
  content,
  onChange,
  onSaved,
  editing = true,
}: {
  project: string;
  path: string;
  content: string;
  onChange: (md: string) => void;
  onSaved?: (md: string) => void;
  editing?: boolean;
}) {
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(content);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  // The serializer drops trailing newlines, so compare normalized: a file
  // ending in "\n" is identical to its serialized form.
  const norm = (s: string) => s.replace(/\n+$/, "");
  const loadedRef = useRef(content);

  const scheduleSave = () => {
    setStatus("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const text = latest.current;
      api
        .filesWrite(project, path, text)
        .then(() => {
          setStatus("saved");
          onSavedRef.current?.(text);
        })
        .catch(() => setStatus("error"));
    }, 600);
  };

  const editor = useEditor(
    {
      extensions: [
        StarterKit,
        Link.configure({ openOnClick: false }),
        Table.configure({ resizable: false }),
        TableRow,
        TableHeader,
        TableCell,
        TaskList,
        TaskItem.configure({ nested: true }),
        Markdown.configure({ html: false, breaks: true, linkify: false }),
      ],
      content,
      editable: editing,
      editorProps: {
        attributes: {
          spellcheck: "false",
        },
      },
      onUpdate: ({ editor }) => {
        const md = editor.storage.markdown.getMarkdown() as string;
        // TipTap fires onUpdate for its initial parse transaction too. When
        // the serialized form still matches what was loaded, that is mount
        // noise, not an edit — sync silently so merely opening a file (in
        // particular read-only) never dirties or rewrites it.
        if (norm(md) === norm(loadedRef.current)) {
          latest.current = md;
          return;
        }
        latest.current = md;
        onChangeRef.current(md);
        scheduleSave();
      },
    },
    [path],
  );

  // The IDE toggle flips editability in place (same document, no remount).
  useEffect(() => {
    editor?.setEditable(editing);
  }, [editor, editing]);

  // Flush a pending save when unmounting (file switched / project changed).
  // The normalized comparison matches the onUpdate guard: mount noise must
  // not write on the way out either.
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      if (norm(latest.current) !== norm(content)) {
        // fire-and-forget; errors surface on the next save
        void api.filesWrite(project, path, latest.current).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, project]);

  return (
    <div className={`note-editor${editing ? "" : " readonly"}`}>
      <EditorContent editor={editor} className="note-editor-scroll" />
      <div className="raw-status dim">
        {status === "saving" && "saving…"}
        {status === "saved" && "saved ✓"}
        {status === "error" && "save failed"}
      </div>
    </div>
  );
}
