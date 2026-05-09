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

import { useJumpToHit } from "@/components/sidebar/useJumpToHit";
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

// In-session id hit. The bar greps content + scans node ids in
// parallel; both feed the same dropdown so a paste of a node id
// resolves to a navigate-to-node action without forcing the user to
// switch UI to the sidebar Jump mode.
interface IdHit {
  kind: "chatnode" | "worknode";
  nodeId: string;
  // For WorkNode hits: the owner ChatNode id, resolved client-side
  // by walking workflow.nodes. Used by useJumpToHit to drill into
  // the right WorkFlow without re-scanning the chatFlow.
  parentChatNodeId?: string;
  // Short human-readable label so the row gives more than just hex.
  // ChatNode → first ~40 chars of user message; WorkNode → kind +
  // toolName/agentType when applicable.
  preview: string;
  // Where in the normalized id (= dashes stripped, lowercased) the
  // user's prefix landed. Used to highlight inside the rendered id.
  matchStart: number;
  matchEnd: number;
}

// Min hex characters the user must paste before id matching kicks in.
// Below this, every short word (e.g. "cafe", "deed") would explode the
// dropdown with hundreds of UUID prefix matches.
const ID_MIN_HEX_LEN = 6;
const HEX_ONLY_RE = /^[0-9a-f-]+$/i;

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

  // Live chatFlow for client-side id matching. Subscribing to the
  // session-state Map and indexing inside the selector keeps re-render
  // scope tight — only flips when this session's chatFlow object
  // identity changes (= initial load + lazy lite ChatFlow refetch).
  const chatFlow = useStore((s) => s.sessions.get(sessionId)?.chatFlow);

  // Compute id hits client-side. Pure derivation from query + chatFlow,
  // so memoise to avoid re-walking 1000+ nodes on every keystroke.
  const idHits = useMemo<IdHit[]>(() => {
    if (!chatFlow || !query) return [];
    const stripped = query.replace(/-/g, "").toLowerCase();
    if (stripped.length < ID_MIN_HEX_LEN) return [];
    if (!HEX_ONLY_RE.test(query)) return [];
    return collectIdHits(chatFlow, stripped);
  }, [chatFlow, query]);

  // Store actions for jump
  const setSelected = useStore((s) => s.setSelected);
  const setDrillPanelTab = useStore((s) => s.setDrillPanelTab);
  const setSearchHighlight = useStore((s) => s.setSearchHighlight);
  const jumpToIdHit = useJumpToHit();

  // Open the dropdown immediately when id hits land — content fetch
  // is debounced by 300ms, but id matches are instant + always-on for
  // hex queries, so showing them right away makes the bar feel snappy.
  useEffect(() => {
    if (idHits.length > 0) setOpen(true);
  }, [idHits.length]);

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

  // Combined navigation list: id hits first (free + instant + usually
  // exactly what the user wanted when they pasted an id), content hits
  // after. activeIdx walks across both.
  const totalHits = idHits.length + (hits?.length ?? 0);

  const activateAt = useCallback(
    (idx: number) => {
      if (idx < idHits.length) {
        const h = idHits[idx];
        void jumpToIdHit(
          h.kind === "chatnode"
            ? { type: "chatnode", sessionId, chatNodeId: h.nodeId }
            : {
                type: "worknode",
                sessionId,
                workNodeId: h.nodeId,
                parentChatNodeId: h.parentChatNodeId,
              },
        );
        setOpen(false);
        inputRef.current?.blur();
        return;
      }
      const ch = hits?.[idx - idHits.length];
      if (ch) jumpToHit(ch);
    },
    [idHits, hits, sessionId, jumpToIdHit, jumpToHit],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (totalHits === 0) {
      if (e.key === "Escape") {
        setQuery("");
        setOpen(false);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(totalHits - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      activateAt(activeIdx);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div
      data-testid="session-search-bar"
      // top-14 (56px) clears the DrillBreadcrumb pinned at left-3
      // top-3 (~48px tall including the pill chrome) when in
      // workflow / sub-chatflow modes. Was top-3 originally; user
      // reported the overlap in narrow-viewport workflow drill on
      // 2026-05-08. Chatflow mode has no breadcrumb so the extra
      // ~44px gap looks slightly empty but not misaligned —
      // accepted tradeoff vs adding mode-conditional positioning.
      className="absolute left-1/2 top-14 z-30 -translate-x-1/2"
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
        {(hits || idHits.length > 0) && !loading && (
          <span className="text-[10px] text-gray-500 font-mono">
            {totalHits}
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
      {open && (hits || idHits.length > 0) && (
        <div
          data-testid="session-search-results"
          className="mt-2 max-h-[60vh] overflow-y-auto rounded-2xl border border-gray-200 bg-white/95 backdrop-blur shadow-lg"
        >
          {idHits.map((hit, i) => (
            <IdHitRow
              key={`id-${hit.nodeId}-${i}`}
              hit={hit}
              active={i === activeIdx}
              onMouseEnter={() => setActiveIdx(i)}
              onClick={() => activateAt(i)}
            />
          ))}
          {idHits.length > 0 && hits && hits.length > 0 && (
            <div className="border-t border-gray-100" />
          )}
          {hits && hits.length === 0 && idHits.length === 0 && !error && (
            <div className="px-3 py-2 text-[12px] italic text-gray-400">
              {t("session_search.no_results")}
            </div>
          )}
          {error && (
            <div className="px-3 py-2 text-[12px] italic text-rose-600">
              ✗ {error}
            </div>
          )}
          {hits?.map((hit, i) => {
            const idx = idHits.length + i;
            return (
              <HitRow
                key={`${hit.recordUuid}-${hit.matchStart}-${i}`}
                hit={hit}
                active={idx === activeIdx}
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => jumpToHit(hit)}
              />
            );
          })}
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

// Render a node-id match. 🎯 + kind chip + the full id (with the
// matched prefix highlighted) + a short preview pulled from the node
// (user message for ChatNode; tool/agent name for WorkNode). Click /
// Enter routes through useJumpToHit so canvas + drill state line up.
function IdHitRow({
  hit,
  active,
  onMouseEnter,
  onClick,
}: {
  hit: IdHit;
  active: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
}) {
  const kindLabel = hit.kind === "chatnode" ? "ChatNode" : "WorkNode";
  const kindColor =
    hit.kind === "chatnode" ? "text-blue-700" : "text-amber-700";
  const idHighlight = useMemo(
    () => splitIdForHighlight(hit.nodeId, hit.matchStart, hit.matchEnd),
    [hit.nodeId, hit.matchStart, hit.matchEnd],
  );
  return (
    <button
      type="button"
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      data-testid={`session-search-id-hit-${hit.nodeId}`}
      data-active={active ? "true" : "false"}
      className={[
        "flex w-full items-start gap-2 px-3 py-1.5 text-left text-[12px] transition-colors",
        active ? "bg-blue-50" : "hover:bg-gray-50",
      ].join(" ")}
    >
      <span className="shrink-0 text-rose-600">🎯</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5">
          <span className={`text-[10px] font-mono ${kindColor}`}>
            {kindLabel}
          </span>
          <span className="text-[11px] font-mono text-gray-700 truncate">
            {idHighlight.before}
            <mark className="bg-yellow-200 text-gray-900 rounded px-0.5">
              {idHighlight.match}
            </mark>
            {idHighlight.after}
          </span>
        </div>
        {hit.preview && (
          <div className="text-[12px] text-gray-700 break-all line-clamp-1">
            {hit.preview}
          </div>
        )}
      </div>
    </button>
  );
}

// Walk all ChatNodes (id match) + their workflow.nodes (WorkNode id
// match). `prefix` is the dash-stripped, lowercased query — and it has
// already been length-gated by the caller. Returns at most 20 hits to
// keep the dropdown manageable when someone pastes a 1-2 char hex
// string under the gate (today the gate is 6+ so this is mostly a
// belt-and-suspenders cap).
function collectIdHits(
  chatFlow: import("@/data/types").ChatFlow,
  prefix: string,
): IdHit[] {
  const hits: IdHit[] = [];
  const MAX = 20;
  for (const cn of chatFlow.chatNodes) {
    if (hits.length >= MAX) break;
    const m = matchIn(cn.id, prefix);
    if (m) {
      hits.push({
        kind: "chatnode",
        nodeId: cn.id,
        preview: previewForChatNode(cn),
        matchStart: m.start,
        matchEnd: m.end,
      });
    }
    for (const wn of cn.workflow.nodes) {
      if (hits.length >= MAX) break;
      const wm = matchIn(wn.id, prefix);
      if (wm) {
        hits.push({
          kind: "worknode",
          nodeId: wn.id,
          parentChatNodeId: cn.id,
          preview: previewForWorkNode(wn),
          matchStart: wm.start,
          matchEnd: wm.end,
        });
      }
    }
  }
  return hits;
}

// Match `prefix` (already dash-free + lowercased) inside a node id
// (which contains dashes). Compare against the dash-stripped form so a
// query like "8b4e47d8" matches "0a2e2200-8b4e-47d8-…" — but report
// the offsets back into the original (dashed) string so highlighting
// stays visually accurate.
function matchIn(
  nodeId: string,
  prefix: string,
): { start: number; end: number } | null {
  const lower = nodeId.toLowerCase();
  const stripped = lower.replace(/-/g, "");
  const at = stripped.indexOf(prefix);
  if (at < 0) return null;
  // Map the [at, at+prefix.length) window from stripped-space back into
  // original-space (which has dashes interspersed).
  let consumed = 0;
  let start = -1;
  let end = -1;
  for (let i = 0; i < lower.length; i++) {
    if (lower[i] === "-") continue;
    if (consumed === at && start < 0) start = i;
    consumed++;
    if (consumed === at + prefix.length) {
      end = i + 1;
      break;
    }
  }
  if (start < 0 || end < 0) return null;
  return { start, end };
}

function splitIdForHighlight(
  id: string,
  start: number,
  end: number,
): { before: string; match: string; after: string } {
  return {
    before: id.slice(0, start),
    match: id.slice(start, end),
    after: id.slice(end),
  };
}

function previewForChatNode(cn: import("@/data/types").ChatNode): string {
  const c = cn.userMessage.content;
  let text = "";
  if (typeof c === "string") {
    text = c;
  } else if (Array.isArray(c)) {
    for (const block of c) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: string }).type === "text"
      ) {
        text = (block as { text?: string }).text ?? "";
        if (text) break;
      }
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > 60 ? text.slice(0, 60) + "…" : text;
}

function previewForWorkNode(wn: import("@/data/types").WorkNode): string {
  switch (wn.kind) {
    case "tool_call":
      return `🔧 ${wn.toolName}`;
    case "delegate":
      return `🌳 ${wn.toolName}${wn.agentType ? ` · ${wn.agentType}` : ""}`;
    case "llm_call":
      return "🧠 llm_call";
    case "compact":
      return "⊞ compact";
    case "attachment":
      return `📎 ${wn.attachmentType}`;
  }
}
