// v0.11 Phase 2 — session-content search bar.
//
// Layout: floats at the top-center of the canvas-host, with margin
// from both the Header above and the canvas below (per user spec
// "不要紧贴着 canvas 上面"). Pill-shaped (rounded-full).
//
// Interaction:
// - Type → 300 ms debounce → fetch → dropdown shows hits
// - ↑/↓ navigate, Enter jumps, Esc closes
// - Aa toggle for case-sensitive
// - Click hit → store actions: select ChatNode + switch DrillPanel
//   to Conversation tab + scroll Conversation to recordUuid +
//   highlight match for ~1.5 s

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useStore } from "@/store";

interface ContentHit {
  recordUuid: string;
  chatNodeId: string;
  role: "user" | "assistant" | "tool" | "thinking";
  kindDetail?: string;
  snippet: string;
  matchStart: number;
  matchEnd: number;
  subAgentId?: string;
}

interface SearchResp {
  hits: ContentHit[];
  truncated: boolean;
  scannedRecords: number;
  durationMs: number;
}

const DEBOUNCE_MS = 300;

interface Props {
  sessionId: string;
}

export function SessionSearchBar({ sessionId }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [hits, setHits] = useState<ContentHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Reset hits + close dropdown when switching session.
  useEffect(() => {
    setQuery("");
    setHits(null);
    setOpen(false);
    setError(null);
  }, [sessionId]);

  // Debounced fetch
  useEffect(() => {
    if (!query) {
      setHits(null);
      setOpen(false);
      setError(null);
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const tid = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const url = `/api/sessions/${sessionId}/search/content?q=${encodeURIComponent(
          query,
        )}${caseSensitive ? "&cs=1" : ""}`;
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) {
          setError(`HTTP ${res.status}`);
          setHits([]);
          setTruncated(false);
          setOpen(true);
          return;
        }
        const data = (await res.json()) as SearchResp;
        if (ctrl.signal.aborted) return;
        setHits(data.hits);
        setTruncated(data.truncated);
        setActiveIdx(0);
        setOpen(true);
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(tid);
    };
  }, [query, caseSensitive, sessionId]);

  // Store actions for jump
  const setSelected = useStore((s) => s.setSelected);
  const setDrillPanelTab = useStore((s) => s.setDrillPanelTab);
  const setSearchHighlight = useStore((s) => s.setSearchHighlight);

  const jumpToHit = useCallback(
    (hit: ContentHit) => {
      setSelected(sessionId, hit.chatNodeId);
      setDrillPanelTab("conversation");
      setSearchHighlight({
        sessionId,
        recordUuid: hit.recordUuid,
        chatNodeId: hit.chatNodeId,
        query,
        caseSensitive,
        receivedAt: Date.now(),
      });
      setOpen(false);
      inputRef.current?.blur();
    },
    [sessionId, query, caseSensitive, setSelected, setDrillPanelTab, setSearchHighlight],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!hits || hits.length === 0) {
      if (e.key === "Escape") {
        setQuery("");
        setOpen(false);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(hits.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (hits[activeIdx]) jumpToHit(hits[activeIdx]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div
      data-testid="session-search-bar"
      className="absolute left-1/2 top-3 z-30 -translate-x-1/2"
      style={{ width: "min(480px, calc(100% - 32px))" }}
    >
      {/* Pill input */}
      <div
        className={[
          "flex items-center gap-1.5 rounded-full border border-gray-300 bg-white/95 backdrop-blur shadow-md transition-shadow",
          "px-3 py-1.5 text-[12px]",
          open && hits && hits.length > 0 ? "shadow-lg" : "",
        ].join(" ")}
      >
        <span className="text-gray-400 select-none">🔍</span>
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder={t("session_search.placeholder")}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => {
            if (hits && hits.length > 0) setOpen(true);
          }}
          className="flex-1 bg-transparent outline-none text-gray-800 placeholder-gray-400"
          data-testid="session-search-input"
        />
        {loading && (
          <span className="text-[10px] text-gray-400">…</span>
        )}
        {hits && !loading && (
          <span className="text-[10px] text-gray-500 font-mono">
            {hits.length}
            {truncated ? "+" : ""}
          </span>
        )}
        <button
          type="button"
          onClick={() => setCaseSensitive((v) => !v)}
          data-testid="session-search-case-toggle"
          aria-pressed={caseSensitive}
          title={t("session_search.case_toggle_tooltip")}
          className={[
            "rounded-full px-1.5 py-0.5 text-[10px] font-mono transition-colors",
            caseSensitive
              ? "bg-blue-100 text-blue-700"
              : "text-gray-400 hover:bg-gray-100 hover:text-gray-600",
          ].join(" ")}
        >
          Aa
        </button>
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setHits(null);
              setOpen(false);
              inputRef.current?.focus();
            }}
            className="text-gray-400 hover:text-gray-600"
            title={t("session_search.clear_tooltip")}
            data-testid="session-search-clear"
          >
            ✕
          </button>
        )}
      </div>

      {/* Hits dropdown */}
      {open && hits && (
        <div
          data-testid="session-search-results"
          className="mt-2 max-h-[60vh] overflow-y-auto rounded-2xl border border-gray-200 bg-white/95 backdrop-blur shadow-lg"
        >
          {hits.length === 0 && !error && (
            <div className="px-3 py-2 text-[12px] italic text-gray-400">
              {t("session_search.no_results")}
            </div>
          )}
          {error && (
            <div className="px-3 py-2 text-[12px] italic text-rose-600">
              ✗ {error}
            </div>
          )}
          {hits.map((hit, i) => (
            <HitRow
              key={`${hit.recordUuid}-${hit.matchStart}-${i}`}
              hit={hit}
              active={i === activeIdx}
              onMouseEnter={() => setActiveIdx(i)}
              onClick={() => jumpToHit(hit)}
            />
          ))}
          {truncated && (
            <div className="px-3 py-1.5 text-[11px] italic text-gray-400 border-t border-gray-100">
              {t("session_search.truncated_hint")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function HitRow({
  hit,
  active,
  onMouseEnter,
  onClick,
}: {
  hit: ContentHit;
  active: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
}) {
  const roleConfig = useMemo(() => {
    switch (hit.role) {
      case "user":
        return { icon: "👤", label: "user", color: "text-blue-700" };
      case "assistant":
        return { icon: "🤖", label: "assistant", color: "text-emerald-700" };
      case "thinking":
        return { icon: "💭", label: "thinking", color: "text-purple-700" };
      case "tool":
        return {
          icon: hit.kindDetail === "result" ? "📦" : "🔧",
          label: hit.kindDetail || "tool",
          color: "text-amber-700",
        };
    }
  }, [hit.role, hit.kindDetail]);

  // Pre-split snippet at match boundaries for highlighting
  const before = hit.snippet.slice(0, hit.matchStart);
  const matched = hit.snippet.slice(hit.matchStart, hit.matchEnd);
  const after = hit.snippet.slice(hit.matchEnd);

  return (
    <button
      type="button"
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      data-testid={`session-search-hit-${hit.recordUuid}`}
      data-active={active ? "true" : "false"}
      className={[
        "flex w-full items-start gap-2 px-3 py-1.5 text-left text-[12px] transition-colors",
        active ? "bg-blue-50" : "hover:bg-gray-50",
      ].join(" ")}
    >
      <span className={`shrink-0 ${roleConfig.color}`}>{roleConfig.icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5">
          <span className={`text-[10px] font-mono ${roleConfig.color}`}>
            {roleConfig.label}
          </span>
          {hit.subAgentId && (
            <span className="text-[10px] font-mono text-gray-400">
              🌳 sub
            </span>
          )}
          <span className="text-[10px] font-mono text-gray-400 truncate">
            CN {hit.chatNodeId.slice(0, 8)}
          </span>
        </div>
        <div className="text-[12px] text-gray-700 break-all line-clamp-2">
          {before}
          <mark className="bg-yellow-200 text-gray-900 rounded px-0.5">
            {matched}
          </mark>
          {after}
        </div>
      </div>
    </button>
  );
}
