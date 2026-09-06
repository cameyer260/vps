import { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import { api } from "../api";

/**
 * Spreadsheet-style CSV editor (task 11): papaparse in, editable grid,
 * papaparse out. Cell editing is the point — no formulas, no spreadsheet
 * engine. Autosaves debounced to /api/notes/file like the markdown editor.
 * Keyed by path in the parent (one instance per open file).
 */

const MAX_CELLS = 400_000; // guard against pathological files
const MAX_RENDER_ROWS = 2000; // plain table; window if ever exceeded

export function CsvEditor({
  path,
  content,
  onChange,
}: {
  path: string;
  content: string;
  onChange: (csv: string) => void;
}) {
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [gridError, setGridError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Parse once per file (parent keys us by path); rows live in state after.
  const initial = useMemo(() => {
    const parsed = Papa.parse<string[]>(content, {
      skipEmptyLines: false,
    });
    if (parsed.errors.length > 0) {
      const first = parsed.errors[0]!;
      // row-mismatched lengths are normal in hand-edited CSVs — papaparse
      // pads/keeps them; only hard failures block editing
      if (first.code === "TooFewFields" || first.code === "TooManyFields") {
        return { rows: parsed.data, error: null };
      }
      return { rows: [] as string[][], error: `${first.code ?? "parse error"}: ${first.message}` };
    }
    return { rows: parsed.data, error: null };
  }, [content]);

  const [rows, setRows] = useState<string[][]>(initial.rows);

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
        .notesWrite(path, csv)
        .then(() => setStatus("saved"))
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

  if (gridError || rows.length === 0) {
    return (
      <div className="csv-editor">
        <div className="empty">
          <p>Couldn't parse this CSV.</p>
          <p className="dim">{gridError ?? "no rows"}</p>
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
        <button className="btn small" onClick={addRow}>
          + row
        </button>
        <button className="btn small" onClick={addColumn}>
          + column
        </button>
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
                  {r > 0 && (
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
