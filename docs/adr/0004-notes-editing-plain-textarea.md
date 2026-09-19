# Notes IDE editing is a plain textarea swap, not a WYSIWYG editor

The notes viewer is read-first: server-rendered markdown (the same
pulldown-cmark + ammonia pipeline as chat). Clicking edit swaps the rendered
view for a full-viewport monospace textarea holding the markdown source —
no split pane, no rich-text engine. The textarea is the investment: autosave
(debounced, with a saved indicator), list auto-continuation, Tab-indent,
draft-unsaved warning, ≥16px font so mobile doesn't zoom on focus. Markdown
source is the single source of truth — nothing converts between formats, so
nothing is lossy (the old tiptap/tiptap-markdown pairing was a lossy
bidirectional compromise). Heavy editing goes to agents; the textarea exists
for quick notes and phone dictation (Apple speech-to-text), which native
textareas handle for free.

Rejected: keeping tiptap (rich affordances, but the largest dependency in
the old frontend and the thing this port exists to remove) or CodeMirror 6
(modular, but still a client-side editor framework). CSV grids stay
table-based: Rust-parsed CSV, contenteditable cells.
