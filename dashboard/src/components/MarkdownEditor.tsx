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
 * elements you edit in place (Obsidian-style). Markdown in (tab content),
 * markdown out (debounced POST to /api/notes/file).
 *
 * Keyed by note path in the parent: one editor instance per open file, so
 * switching tabs never serializes/deserializes mid-keystroke.
 */
export function MarkdownEditor({ path, content, onChange }: { path: string; content: string; onChange: (md: string) => void }) {
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(content);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

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
      editorProps: {
        attributes: {
          spellcheck: "false",
        },
      },
      onUpdate: ({ editor }) => {
        const md = editor.storage.markdown.getMarkdown() as string;
        latest.current = md;
        onChangeRef.current(md);
        setStatus("saving");
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          api
            .notesWrite(path, latest.current)
            .then(() => setStatus("saved"))
            .catch(() => setStatus("error"));
        }, 600);
      },
    },
    [path],
  );

  // Flush a pending save when unmounting (tab closed / file switched).
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      if (latest.current !== content) {
        // fire-and-forget; errors surface on the next save
        void api.notesWrite(path, latest.current).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return (
    <div className="note-editor">
      <EditorContent editor={editor} className="note-editor-scroll" />
      <div className="raw-status dim">
        {status === "saving" && "saving…"}
        {status === "saved" && "saved ✓"}
        {status === "error" && "save failed"}
      </div>
    </div>
  );
}
