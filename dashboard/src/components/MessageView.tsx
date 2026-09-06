import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../api";
import type { Item, PiModel } from "../types";

export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

export function MessageView({ item }: { item: Item }) {
  if (item.kind === "user") {
    return (
      <div className="msg user">
        <div className="bubble">{item.text}</div>
      </div>
    );
  }

  if (item.kind === "compaction") {
    return (
      <div className="compaction">
        <details>
          <summary>context compacted</summary>
          <p className="dim">{item.summary}</p>
        </details>
      </div>
    );
  }

  if (item.kind === "toolresult") {
    return <ToolCard name={item.toolName} argsText={null} result={{ text: item.text, isError: item.isError }} running={false} output={null} />;
  }

  // assistant
  return (
    <div className="msg assistant">
      {item.thinking.map((t, i) => (
        <details key={i} className="thinking">
          <summary>thinking</summary>
          <div className="thinking-body">{t}</div>
        </details>
      ))}
      {item.tools.map((tool) => (
        <ToolCard
          key={tool.id}
          name={tool.name}
          argsText={tool.argsText}
          output={tool.output}
          result={tool.result}
          running={tool.running}
        />
      ))}
      {item.text.map((t, i) => (
        <Markdown key={i}>{t}</Markdown>
      ))}
      {!item.done && <span className="cursor" aria-hidden="true" />}
    </div>
  );
}

function ToolCard({
  name,
  argsText,
  output,
  result,
  running,
}: {
  name: string;
  argsText: string | null;
  output: string | null;
  result: { text: string; isError: boolean } | null;
  running: boolean;
}) {
  const [open, setOpen] = useState(false);
  const status = running ? "…" : result ? (result.isError ? "✗" : "✓") : "";
  // Show the bash command on the summary line for quick scanning.
  let summaryArg = "";
  if (argsText && name === "bash") {
    try {
      const parsed = JSON.parse(argsText) as { command?: string };
      summaryArg = parsed.command ?? "";
    } catch {
      summaryArg = argsText;
    }
  }
  return (
    <div className={`tool-card${result?.isError ? " error" : ""}${open ? " open" : ""}`}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className="tool-status">{status}</span>
        <span className="tool-name">{name}</span>
        {summaryArg && <code className="tool-brief">{truncate(summaryArg, 80)}</code>}
      </button>
      {open && (
        <div className="tool-body">
          {argsText && (
            <>
              <div className="tool-label">input</div>
              <pre>{argsText}</pre>
            </>
          )}
          {output && (
            <>
              <div className="tool-label">output (partial)</div>
              <pre>{output}</pre>
            </>
          )}
          {result && (
            <>
              <div className="tool-label">result</div>
              <pre>{result.text || "(no output)"}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

// "All models" cache shared across chats — the catalog is agent-independent.
let allModelsCache: PiModel[] | null = null;

export function ModelPicker({
  models,
  current,
  onPick,
}: {
  models: PiModel[] | null; // the agent's configured scope (get_available_models)
  current: PiModel | null;
  onPick: (provider: string, id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<"scoped" | "all">("scoped");
  const [allModels, setAllModels] = useState<PiModel[] | null>(allModelsCache);
  const [allError, setAllError] = useState<string | null>(null);

  const label = current ? current.id : "model";
  const activeModels = source === "scoped" ? models : allModels;
  const filtered = (activeModels ?? []).filter((m) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return m.id.toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q);
  });

  const switchSource = (next: "scoped" | "all") => {
    setSource(next);
    if (next === "all" && !allModels && !allError) {
      api
        .allModels()
        .then((r) => {
          allModelsCache = r.models;
          setAllModels(r.models);
        })
        .catch((e) => setAllError(String((e as Error).message ?? e)));
    }
  };

  return (
    <div className="model-picker">
      <button className="btn ghost" onClick={() => setOpen(!open)}>
        {label} ▾
      </button>
      {open && (
        <>
          <div className="scrim" onClick={() => setOpen(false)} />
          <div className="model-pop">
            <div className="model-source-toggle" role="tablist">
              <button
                className={`chip${source === "scoped" ? " on" : ""}`}
                onClick={() => switchSource("scoped")}
                title="Models this agent has configured"
              >
                scoped ({models?.length ?? "…"})
              </button>
              <button
                className={`chip${source === "all" ? " on" : ""}`}
                onClick={() => switchSource("all")}
                title="Everything the pi CLI catalog lists"
              >
                all models
              </button>
            </div>
            <input
              className="input"
              autoFocus
              placeholder="filter models…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="model-list">
              {source === "all" && allError && <div className="dim pad">{allError}</div>}
              {source === "all" && !allModels && !allError && (
                <div className="dim pad">loading catalog…</div>
              )}
              {filtered.length === 0 && (source === "scoped" || allModels) && (
                <div className="dim pad">no models match</div>
              )}
              {filtered.map((m) => (
                <button
                  key={`${m.provider}/${m.id}`}
                  className={`model-row${current?.id === m.id && current?.provider === m.provider ? " current" : ""}`}
                  onClick={() => {
                    onPick(m.provider, m.id);
                    setOpen(false);
                  }}
                >
                  <span>{m.name ?? m.id}</span>
                  {m.name && m.name !== m.id && <span className="dim">{m.id}</span>}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
