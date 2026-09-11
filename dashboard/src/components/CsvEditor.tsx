import { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import { api } from "../api";

/**
 * Spreadsheet-style CSV editor (task 11): papaparse in, editable grid,
 * papaparse out. Cell editing is the point — no formulas, no spreadsheet
 * engine. Autosaves debounced to PUT /api/files/file (IDE project) like
 * the markdown editor. Keyed by project+path in the parent (one instance
 * per open file). Editing is gated by the IDE EditToggle: read-only shows
 * the same grid with disabled cells.
 */

const MAX_CELLS = 400_000; // guard against pathological files
const MAX_RENDER_ROWS = 2000; // plain table; window if ever exceeded

export function CsvEditor({
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
  onChange: (csv: string) => void;
  onSaved?: (csv: string) => void;
  editing?: boolean;
}) {
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [gridError, setGridError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  // Parse once per file (parent keys us by path); rows live in state after.
  const initial = useMemo(() => {
    const parsed = Papa.parse<string[]>(content, {
      skipEmptyLines: false,
    });
    // A trailing newline (what most editors write) parses as final
    // all-empty rows — strip those so normal files open as a clean grid.
    // Interior blank lines are kept so open→save round-trips losslessly.
    const rows = [...parsed.data];
    while (
      rows.length > 0 &&
      Array.isArray(rows[rows.length - 1]) &&
      (rows[rows.length - 1] as string[]).every((cell) => cell === "")
    ) {
      rows.pop();
    }
    if (parsed.errors.length > 0) {
      const first = parsed.errors[0]!;
      // Row-mismatched lengths are normal in hand-edited CSVs — papaparse
      // pads/keeps them. UndetectableDelimiter is also benign when real rows
      // parsed (it fires on the empty tail above, defaulting to ','); only
      // hard failures block editing.
      if (
        first.code === "TooFewFields" ||
        first.code === "TooManyFields" ||
        (first.code === "UndetectableDelimiter" && rows.length > 0)
      ) {
        return { rows, error: null };
      }
      return { rows: [] as string[][], error: `${first.code ?? "parse error"}: ${first.message}` };
    }
    return { rows, error: null };
  }, [content]);

  const [rows, setRows] = useState<string[][]>(initial.rows);
  const [parseError] = useState<string | null>(initial.error);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const scheduleSave = (next: string[][]) => {
    setStatus("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const csv = Papa.unparse(next);
      api
        .filesWrite(project, path, csv)
        .then(() => {
          setStatus("saved");
          onSavedRef.current?.(csv);
        })
        .catch(() => setStatus("error"));
      onChangeRef.current(csv);
    }, 600);
  };

  const updateCell = (r: number, c: number, value: string) => {
    setRows((prev) => {
      const next = prev.map((row, ri) =>
        ri === r ? row.map((cell, ci) => (ci === c ? value : cell)) : row,
      );
      scheduleSave(next);
      return next;
    });
  };

  const addRow = () => {
    setRows((prev) => {
      const width = prev[0]?.length ?? 1;
      const next = [...prev, Array.from({ length: width }, () => "")];
      scheduleSave(next);
      return next;
    });
  };

  const addColumn = () => {
    setRows((prev) => {
      const next = prev.map((row) => [...row, ""]);
      scheduleSave(next);
      return next;
    });
  };

  const deleteRow = (r: number) => {
    setRows((prev) => {
      const next = prev.filter((_, ri) => ri !== r);
      scheduleSave(next);
      return next;
    });
  };

  if (parseError || gridError || rows.length === 0) {
    return (
      <div className="csv-editor">
        <div className="empty">
          <p>Couldn't parse this CSV.</p>
          <p className="dim">{parseError ?? gridError ?? "no rows"}</p>
        </div>
      </div>
    );
  }

  const width = Math.max(...rows.map((r) => r.length));
  const totalCells = rows.length * width;
  const renderRows = rows.slice(0, MAX_RENDER_ROWS);

  return (
    <div className="csv-editor">
      <div className="csv-toolbar">
        {editing && (
          <>
            <button className="btn small" onClick={addRow}>
              + row
            </button>
            <button className="btn small" onClick={addColumn}>
              + column
            </button>
          </>
        )}
        <span className="dim csv-meta">
          {rows.length} rows × {width} cols{totalCells > MAX_CELLS ? " (too large to edit)" : ""}
        </span>
        <span className="raw-status dim inline">
          {status === "saving" && "saving…"}
          {status === "saved" && "saved ✓"}
          {status === "error" && "save failed"}
        </span>
      </div>
      <div className="csv-scroll">
        <table className="csv-grid">
          <tbody>
            {renderRows.map((row, r) => (
              <tr key={r}>
                <td className="csv-rownum">
                  {r === 0 ? "" : r}
                  {editing && r > 0 && (
                    <button
                      type="button"
                      className="csv-rowdel"
                      title="Delete row"
                      aria-label={`Delete row ${r}`}
                      onClick={() => deleteRow(r)}
                    >
                      ×
                    </button>
                  )}
                </td>
                {Array.from({ length: width }, (_, c) => (
                  <td key={c}>
                    <input
                      value={row[c] ?? ""}
                      onChange={(e) => updateCell(r, c, e.target.value)}
                      className={r === 0 ? "csv-head-cell" : ""}
                      spellCheck={false}
                      disabled={!editing}
                      aria-label={`row ${r + 1}, column ${c + 1}`}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > MAX_RENDER_ROWS && (
          <div className="dim pad">showing first {MAX_RENDER_ROWS} rows — edit the rest in a text tool</div>
        )}
      </div>
    </div>
  );
}
