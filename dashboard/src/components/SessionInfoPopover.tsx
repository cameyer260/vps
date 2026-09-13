import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { ChatState } from "../chat";
import type { PiModel, SessionStats } from "../types";
import { ModalScrim } from "./Modal";

// "All models" cache shared across chats — the catalog is agent-independent.
// (Moved here with the picker list when the header ModelPicker was folded
// into this modal, so the scoped/all toggle keeps its cross-chat cache.)
let allModelsCache: PiModel[] | null = null;

interface Props {
  model: PiModel | null;
  models: PiModel[] | null; // the agent's configured scope (get_available_models)
  thinkingLevel: string | null;
  thinkingLevels: string[] | null;
  status: ChatState["status"];
  exited: boolean;
  onPickModel: (provider: string, id: string) => void;
  onPickThinkingLevel: (level: string) => void;
  onStats: () => Promise<SessionStats | null>;
  onClose: () => void;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function fmtCost(c: number): string {
  if (!Number.isFinite(c)) return "—";
  return c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`;
}

/**
 * Header info modal (the ⓘ button left of the power button): model, effort,
 * and pi session stats (context window + cost) collapsed out of the crowded
 * chat-head row so the chat name keeps its room.
 *
 * Rendered through the shared portaled `ModalScrim` like every other modal,
 * anchored top-right and narrower than a centered dialog. Model/effort rows
 * drill into nested picker lists (back via ‹ or Escape); stats rows are
 * read-only display refreshed on open and after each settled turn.
 */
export function SessionInfoPopover({
  model,
  models,
  thinkingLevel,
  thinkingLevels,
  status,
  exited,
  onPickModel,
  onPickThinkingLevel,
  onStats,
  onClose,
}: Props) {
  const [view, setView] = useState<"main" | "model" | "effort">("main");
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [statsState, setStatsState] = useState<"loading" | "ready" | "error">("loading");

  // The parent passes fresh closures every render (its chat api memoizes on
  // chat state), so neither `onStats` nor `onClose` is a stable effect dep —
  // mirror them into refs and drive fetching off mount + turn transitions
  // instead. The popover mounts fresh on every open, so mount == open.
  const statsFn = useRef(onStats);
  statsFn.current = onStats;
  const fetchStats = useRef(() => {
    setStatsState("loading");
    statsFn
      .current()
      .then((s) => {
        setStats(s);
        setStatsState(s ? "ready" : "error");
      })
      .catch(() => setStatsState("error"));
  });
  useEffect(() => {
    fetchStats.current();
  }, []);
  const lastStatus = useRef(status);
  useEffect(() => {
    // Post-turn refresh while open: a settled turn moves token/cost/context
    // numbers, so re-pull once the stream lands (open + post-turn refresh).
    if (lastStatus.current === "streaming" && status === "idle") fetchStats.current();
    lastStatus.current = status;
  }, [status]);

  // Escape backs out of a nested picker first, then closes the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (view !== "main") setView("main");
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, onClose]);

  // Single-level models keep a dimmed, disabled Effort row (never hidden).
  const effortAvailable = !!thinkingLevels && thinkingLevels.length > 1;

  const usage = statsState === "ready" ? stats?.contextUsage : undefined;
  const windowSize = usage?.contextWindow ?? model?.contextWindow ?? null;
  let contextValue = "—";
  if (statsState === "loading") contextValue = "loading…";
  else if (usage && typeof usage.percent === "number") {
    const base = `${Math.round(usage.percent)}%`;
    contextValue =
      typeof usage.tokens === "number" && windowSize
        ? `${base} · ${fmtTokens(usage.tokens)}/${fmtTokens(windowSize)}`
        : base;
  } else if (typeof usage?.tokens === "number" && windowSize) {
    contextValue = `${fmtTokens(usage.tokens)}/${fmtTokens(windowSize)}`;
  } else if (windowSize) {
    contextValue = `0% · ${fmtTokens(windowSize)} window`;
  }
  const contextTitle =
    stats?.tokens != null
      ? `in ${stats.tokens.input ?? 0} · out ${stats.tokens.output ?? 0} · cache read ${stats.tokens.cacheRead ?? 0}`
      : undefined;

  let costValue = "—";
  if (statsState === "loading") costValue = "loading…";
  else if (stats?.cost != null) costValue = fmtCost(stats.cost);

  return (
    <ModalScrim onClose={onClose} className="info-modal-scrim">
      <div
        className="modal info-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Session info"
      >
        {view === "main" && (
          <div className="info-list">
            <button
              className="info-row"
              disabled={exited}
              onClick={() => setView("model")}
              title={model ? `${model.provider}/${model.id}` : "Choose a model"}
            >
              <span className="info-label">Model</span>
              <span className="info-value">{model ? model.id : "model"}</span>
              <span className="info-chevron" aria-hidden="true">
                ›
              </span>
            </button>
            {effortAvailable ? (
              <button
                className="info-row"
                disabled={exited}
                onClick={() => setView("effort")}
                title="Choose the thinking level"
              >
                <span className="info-label">Effort</span>
                <span className="info-value">{thinkingLevel ?? "off"}</span>
                <span className="info-chevron" aria-hidden="true">
                  ›
                </span>
              </button>
            ) : (
              <div
                className="info-row info-row-dim"
                title="This model exposes a single effort level"
                aria-disabled="true"
              >
                <span className="info-label">Effort</span>
                <span className="info-value">{thinkingLevel ?? "—"}</span>
              </div>
            )}
            <div className="info-row" title={contextTitle}>
              <span className="info-label">Context</span>
              <span className="info-value">{contextValue}</span>
            </div>
            <div className="info-row" title="Session total cost">
              <span className="info-label">Cost</span>
              <span className="info-value">{costValue}</span>
            </div>
          </div>
        )}

        {view === "model" && (
          <ModelListView
            models={models}
            current={model}
            onBack={() => setView("main")}
            onPick={(provider, id) => {
              onPickModel(provider, id);
              setView("main");
              fetchStats.current();
            }}
          />
        )}

        {view === "effort" && (
          <div>
            <div className="info-subhead">
              <button className="btn ghost" onClick={() => setView("main")} aria-label="Back">
                ‹
              </button>
              <span className="info-subhead-title">Effort</span>
            </div>
            <div className="model-list">
              {(thinkingLevels ?? []).map((l) => (
                <button
                  key={l}
                  className={`model-row${(thinkingLevel ?? "off") === l ? " current" : ""}`}
                  disabled={exited}
                  onClick={() => {
                    onPickThinkingLevel(l);
                    setView("main");
                  }}
                >
                  <span>{l}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </ModalScrim>
  );
}

/** Nested model picker list (scoped/all + filter), reusing the shared
 *  model-list styles. Split out so the main/effort views stay readable. */
function ModelListView({
  models,
  current,
  onBack,
  onPick,
}: {
  models: PiModel[] | null;
  current: PiModel | null;
  onBack: () => void;
  onPick: (provider: string, id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<"scoped" | "all">("scoped");
  const [allModels, setAllModels] = useState<PiModel[] | null>(allModelsCache);
  const [allError, setAllError] = useState<string | null>(null);

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
    <div>
      <div className="info-subhead">
        <button className="btn ghost" onClick={onBack} aria-label="Back">
          ‹
        </button>
        <span className="info-subhead-title">Model</span>
      </div>
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
            onClick={() => onPick(m.provider, m.id)}
          >
            <span>{m.name ?? m.id}</span>
            {m.name && m.name !== m.id && <span className="dim">{m.id}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
