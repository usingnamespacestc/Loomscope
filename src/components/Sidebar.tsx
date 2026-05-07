// Left-rail session manager. VS Code-style collapsible tree:
//   workspace (cwd) → click ▸ to expand → list of sessions sorted by mtime.
// Click a session row → set as active → canvas loads it.
//
// PR 2.5 (search): the section header is followed by a search bar with
// two modes — 📁 filter (live narrowing of the existing session tree,
// front-end only) and 🎯 jump-by-id (Enter-triggered backend grep that
// replaces the session tree with a candidate list of session/ChatNode/
// WorkNode hits). Toggle modes resets the input and the candidate list.
// Jumping doesn't auto-flip back to filter mode (user may want to try
// other candidates), but clearing the input does collapse the candidate
// panel back to the regular session tree even if the user stays in 🎯.
//
// Visual chrome per `design-visual-language.md` 视觉 token:
//   - 📁 folder emoji (matches Agentloom convention)
//   - hover:bg-blue-50 row accent
//   - active session gets blue left border
//   - section header tracking-wide uppercase

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useStore } from "@/store/index";
import { useJumpToHit, type JumpHit } from "@/components/sidebar/useJumpToHit";

type SearchMode = "filter" | "jump";

interface SearchHit {
  type: "session" | "chatnode" | "worknode";
  sessionId: string;
  chatNodeId?: string;
  workNodeId?: string;
  cwd: string;
  preview?: string;
  kindHint?: string;
  lastModified?: string | null;
}

interface JumpState {
  status: "idle" | "loading" | "done";
  hits: SearchHit[];
  error?: "too_short" | "invalid" | "fetch_failed" | "none";
  truncated?: boolean;
}

export function Sidebar() {
  const { t } = useTranslation();
  const workspaces = useStore((s) => s.workspaces);
  const loading = useStore((s) => s.workspacesLoading);
  const error = useStore((s) => s.workspacesError);
  const expanded = useStore((s) => s.expandedCwds);
  const sessionsByCwd = useStore((s) => s.sessionsByCwd);
  const refresh = useStore((s) => s.refreshWorkspaces);
  const toggleExpanded = useStore((s) => s.toggleExpanded);
  const setActive = useStore((s) => s.setActiveSession);
  const activeId = useStore((s) => s.activeSessionId);
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const collapsed = useStore((s) => s.sidebarCollapsed);

  // PR 2.5 search state — local to Sidebar; not persisted across
  // remounts. Cross-remount memory of the user's preferred search
  // mode would be a nice-to-have but the input itself is ephemeral
  // (a paste-then-jump action), so plain useState is enough.
  const [searchMode, setSearchMode] = useState<SearchMode>("filter");
  const [searchInput, setSearchInput] = useState("");
  const [jumpState, setJumpState] = useState<JumpState>({
    status: "idle",
    hits: [],
  });
  const abortRef = useRef<AbortController | null>(null);
  const jumpToHit = useJumpToHit();

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleModeChange(mode: SearchMode) {
    if (mode === searchMode) return;
    abortRef.current?.abort();
    setSearchMode(mode);
    setSearchInput("");
    setJumpState({ status: "idle", hits: [] });
  }

  function handleClearInput() {
    abortRef.current?.abort();
    setSearchInput("");
    setJumpState({ status: "idle", hits: [] });
  }

  async function triggerJumpSearch() {
    const q = searchInput.trim();
    if (!q) return;
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setJumpState({ status: "loading", hits: [] });
    try {
      const res = await fetch(
        `/api/search/uuid?q=${encodeURIComponent(q)}`,
        { signal: abortRef.current.signal },
      );
      if (!res.ok) {
        setJumpState({
          status: "done",
          hits: [],
          error: "fetch_failed",
        });
        return;
      }
      const j = (await res.json()) as {
        hits?: SearchHit[];
        truncated?: boolean;
        tooShort?: boolean;
        invalid?: boolean;
      };
      if (j.tooShort) {
        setJumpState({ status: "done", hits: [], error: "too_short" });
        return;
      }
      if (j.invalid) {
        setJumpState({ status: "done", hits: [], error: "invalid" });
        return;
      }
      const hits = j.hits ?? [];
      setJumpState({
        status: "done",
        hits,
        error: hits.length === 0 ? "none" : undefined,
        truncated: j.truncated,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // Newer search superseded — leave state alone.
        return;
      }
      setJumpState({
        status: "done",
        hits: [],
        error: "fetch_failed",
      });
    }
  }

  // Filter-mode derived list. Pure front-end pass over the workspace
  // tree: a workspace passes if its cwd matches the input OR any of
  // its loaded sessions matches by id-prefix / title / sessionId
  // substring.
  const filterText =
    searchMode === "filter" ? searchInput.trim().toLowerCase() : "";
  const filteredView = useMemo(() => {
    if (!filterText) return null;
    return workspaces.filter((ws) => {
      if (ws.cwd.toLowerCase().includes(filterText)) return true;
      const sessions = sessionsByCwd.get(ws.cwd) ?? [];
      return sessions.some(
        (s) =>
          s.sessionId.toLowerCase().startsWith(filterText) ||
          s.sessionId.toLowerCase().includes(filterText) ||
          (s.title?.toLowerCase().includes(filterText) ?? false),
      );
    });
  }, [workspaces, sessionsByCwd, filterText]);

  // Should we render the candidate panel instead of the workspace tree?
  // Only when in jump mode with non-empty input or visible state. Empty
  // input in jump mode = show normal sessions (the "回到正常模式"
  // semantics from the design discussion).
  const showCandidatePanel =
    searchMode === "jump" &&
    (jumpState.status !== "idle" || searchInput.trim().length > 0);

  if (collapsed) {
    return (
      <div
        className="bg-gray-50 border-r border-gray-200 flex flex-col items-center py-3"
        style={{ width: 36 }}
      >
        <button
          className="flex h-7 w-7 items-center justify-center rounded text-gray-500 hover:bg-gray-200 hover:text-gray-900 transition-colors"
          title={t("sidebar.expand")}
          onClick={() => useStore.getState().toggleSidebar()}
        >
          ▶
        </button>
      </div>
    );
  }

  const visibleWorkspaces = filteredView ?? workspaces;

  return (
    <aside
      className="bg-gray-50 border-r border-gray-200 flex flex-col"
      style={{ width: sidebarWidth, minWidth: sidebarWidth }}
      data-testid="sidebar"
    >
      {/* Section header */}
      <div className="px-3 py-2 border-b border-gray-200 flex items-center justify-between">
        <span className="text-[10px] font-semibold tracking-widest text-gray-500">
          {t("sidebar.section_title")}
        </span>
        <div className="flex items-center gap-1">
          <button
            className="flex h-6 w-6 items-center justify-center rounded text-gray-400 hover:bg-gray-200 hover:text-gray-700 transition-colors"
            title={t("sidebar.refresh_workspaces")}
            onClick={() => void refresh()}
          >
            ⟳
          </button>
          <button
            className="flex h-6 w-6 items-center justify-center rounded text-gray-400 hover:bg-gray-200 hover:text-gray-700 transition-colors"
            title={t("sidebar.collapse")}
            onClick={() => useStore.getState().toggleSidebar()}
          >
            ◀
          </button>
        </div>
      </div>

      {/* PR 2.5: search toolbar (mode toggle + input). Sits between
          section header and the workspace tree per design spec. */}
      <div
        className="border-b border-gray-200 px-2 py-2 space-y-1.5 bg-white"
        data-testid="sidebar-search"
      >
        <div
          className="flex rounded border border-gray-200 overflow-hidden text-[10px]"
          role="group"
          aria-label="search mode"
        >
          <button
            type="button"
            onClick={() => handleModeChange("filter")}
            className={[
              "flex-1 px-2 py-1 transition-colors",
              searchMode === "filter"
                ? "bg-blue-50 text-blue-700 font-medium"
                : "bg-white text-gray-500 hover:bg-gray-50",
            ].join(" ")}
            title={t("sidebar_search.tooltip_filter")}
            aria-label={t("sidebar_search.mode_filter_aria")}
            data-testid="sidebar-search-mode-filter"
            data-active={searchMode === "filter" ? "true" : "false"}
          >
            📁 {t("sidebar_search.mode_filter")}
          </button>
          <button
            type="button"
            onClick={() => handleModeChange("jump")}
            className={[
              "flex-1 px-2 py-1 transition-colors border-l border-gray-200",
              searchMode === "jump"
                ? "bg-blue-50 text-blue-700 font-medium"
                : "bg-white text-gray-500 hover:bg-gray-50",
            ].join(" ")}
            title={t("sidebar_search.tooltip_jump")}
            aria-label={t("sidebar_search.mode_jump_aria")}
            data-testid="sidebar-search-mode-jump"
            data-active={searchMode === "jump" ? "true" : "false"}
          >
            🎯 {t("sidebar_search.mode_jump")}
          </button>
        </div>
        <div className="flex items-center gap-1">
          <input
            type="text"
            className="flex-1 min-w-0 rounded border border-gray-300 bg-white px-2 py-1 text-[11px] focus:border-blue-400 focus:outline-none"
            placeholder={
              searchMode === "filter"
                ? t("sidebar_search.placeholder_filter")
                : t("sidebar_search.placeholder_jump")
            }
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && searchMode === "jump") {
                e.preventDefault();
                void triggerJumpSearch();
              } else if (e.key === "Escape") {
                handleClearInput();
              }
            }}
            data-testid="sidebar-search-input"
          />
          {searchInput && (
            <button
              type="button"
              onClick={handleClearInput}
              className="flex h-6 w-6 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-700 text-[10px]"
              title={t("sidebar_search.search_button_aria")}
              data-testid="sidebar-search-clear"
            >
              ✕
            </button>
          )}
          {searchMode === "jump" && (
            <button
              type="button"
              onClick={() => void triggerJumpSearch()}
              disabled={!searchInput.trim()}
              className="flex h-6 w-6 items-center justify-center rounded text-gray-500 hover:bg-blue-50 hover:text-blue-700 disabled:opacity-30 disabled:hover:bg-transparent text-[11px]"
              title={t("sidebar_search.search_button_aria")}
              data-testid="sidebar-search-go"
            >
              🔍
            </button>
          )}
        </div>
      </div>

      {/* Status messages */}
      {loading && (
        <div className="px-3 py-2 text-[11px] text-gray-400 inline-flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-teal-400" />
          {t("sidebar.loading_workspaces")}
        </div>
      )}
      {error && (
        <div
          className="mx-2 my-2 rounded bg-rose-50 border border-rose-200 px-2 py-1.5 text-[11px] text-rose-900 break-words"
          data-testid="sidebar-error"
        >
          <span className="font-semibold">{t("sidebar.error_label")}</span>
          <div className="mt-0.5 text-rose-700">{error}</div>
        </div>
      )}
      {!loading && !error && workspaces.length === 0 && (
        <div className="px-3 py-2 text-[11px] text-gray-400">
          {t("sidebar.no_sessions_root")}
        </div>
      )}

      {/* Body — either candidate panel (jump mode active) or workspace tree */}
      <div className="overflow-y-auto flex-1">
        {showCandidatePanel ? (
          <CandidatePanel
            jumpState={jumpState}
            onPickHit={(h) => void jumpToHit(toJumpHit(h))}
            onBack={handleClearInput}
            t={t}
          />
        ) : (
          <ul data-testid="sidebar-workspace-tree">
            {visibleWorkspaces.map((ws) => {
              const isOpen = expanded.has(ws.cwd);
              const allSessions = sessionsByCwd.get(ws.cwd);
              const sessions =
                filterText && allSessions
                  ? allSessions.filter(
                      (s) =>
                        ws.cwd.toLowerCase().includes(filterText) ||
                        s.sessionId.toLowerCase().startsWith(filterText) ||
                        s.sessionId.toLowerCase().includes(filterText) ||
                        (s.title?.toLowerCase().includes(filterText) ?? false),
                    )
                  : allSessions;
              return (
                <li key={ws.cwd} className="border-b border-gray-100">
                  <button
                    className="w-full flex items-center gap-1.5 px-2 py-1.5 hover:bg-gray-100 text-left transition-colors group/folder"
                    onClick={() => toggleExpanded(ws.cwd)}
                    data-testid={`workspace-row-${ws.cwd}`}
                  >
                    <span className="inline-block w-3 text-center text-[9px] text-gray-400 transition-transform">
                      {isOpen ? "▾" : "▸"}
                    </span>
                    <span className="text-[12px]">📁</span>
                    <span
                      className="font-mono text-[11px] text-gray-800 truncate flex-1 font-medium"
                      title={ws.cwd}
                    >
                      {basename(ws.cwd)}
                    </span>
                    <span className="text-[10px] text-gray-400 font-mono">
                      {ws.sessionCount}
                    </span>
                  </button>
                  {isOpen && (
                    <ul className="bg-white" data-testid={`session-list-${ws.cwd}`}>
                      {!sessions && (
                        <li className="px-6 py-1.5 text-[10px] text-gray-400 italic">
                          {t("sidebar.loading_sessions")}
                        </li>
                      )}
                      {sessions?.length === 0 && (
                        <li className="px-6 py-1.5 text-[10px] text-gray-400 italic">
                          {t("sidebar.no_sessions_in_workspace")}
                        </li>
                      )}
                      {sessions?.map((s) => {
                        const isActive = activeId === s.sessionId;
                        return (
                          <li key={s.sessionId}>
                            <button
                              className={[
                                "w-full text-left pl-6 pr-2 py-1.5 transition-colors border-l-2",
                                isActive
                                  ? "bg-blue-50 border-blue-500 text-blue-900"
                                  : "border-transparent text-gray-700 hover:bg-blue-50/60 hover:border-blue-200",
                              ].join(" ")}
                              onClick={() => setActive(s.sessionId)}
                              data-testid={`session-row-${s.sessionId}`}
                              title={`${s.sessionId} · ${formatBytes(s.fileSize)} · ${s.messageCount} ${t("sidebar.session_records_unit")}`}
                            >
                              <div className="truncate text-[11px]">
                                {s.title}
                              </div>
                              <div className="text-[10px] text-gray-400 flex justify-between mt-0.5">
                                <span className="font-mono">
                                  {s.sessionId.slice(0, 8)}
                                </span>
                                <span className="font-mono">
                                  {formatBytes(s.fileSize)}
                                </span>
                              </div>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

function CandidatePanel({
  jumpState,
  onPickHit,
  onBack,
  t,
}: {
  jumpState: JumpState;
  onPickHit: (h: SearchHit) => void;
  onBack: () => void;
  t: (k: string) => string;
}) {
  return (
    <div className="px-2 py-2 space-y-2" data-testid="sidebar-candidate-panel">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold tracking-widest text-gray-500">
          {t("sidebar_search.results_heading")}
          {jumpState.status === "done" && jumpState.hits.length > 0 && (
            <span className="ml-1 font-mono text-gray-400">
              ({jumpState.hits.length})
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={onBack}
          className="text-[10px] text-gray-500 hover:text-gray-700 underline"
          data-testid="sidebar-candidate-back"
        >
          {t("sidebar_search.back_to_sessions")}
        </button>
      </div>
      {jumpState.status === "loading" && (
        <div className="text-[11px] text-gray-400 italic px-1">
          {t("sidebar_search.loading")}
        </div>
      )}
      {jumpState.status === "done" && jumpState.error === "too_short" && (
        <div className="text-[11px] text-amber-700 italic px-1">
          {t("sidebar_search.too_short")}
        </div>
      )}
      {jumpState.status === "done" && jumpState.error === "invalid" && (
        <div className="text-[11px] text-amber-700 italic px-1">
          {t("sidebar_search.invalid_input")}
        </div>
      )}
      {jumpState.status === "done" && jumpState.error === "none" && (
        <div className="text-[11px] text-gray-500 italic px-1">
          {t("sidebar_search.no_results")}
        </div>
      )}
      {jumpState.status === "done" && jumpState.error === "fetch_failed" && (
        <div className="text-[11px] text-rose-700 italic px-1">
          {t("sidebar_search.no_results")}
        </div>
      )}
      {jumpState.status === "done" && jumpState.hits.length > 0 && (
        <ul className="space-y-1">
          {jumpState.hits.map((h) => (
            <li key={candidateKey(h)}>
              <button
                type="button"
                onClick={() => onPickHit(h)}
                className="w-full text-left rounded border border-gray-200 bg-white hover:border-blue-400 hover:bg-blue-50 px-2 py-1.5 transition-colors"
                data-testid={`sidebar-candidate-${candidateKey(h)}`}
              >
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span
                    className={[
                      "rounded px-1 py-px text-[9px] font-medium uppercase tracking-wide",
                      h.type === "session"
                        ? "bg-purple-100 text-purple-800"
                        : h.type === "chatnode"
                          ? "bg-blue-100 text-blue-800"
                          : "bg-amber-100 text-amber-800",
                    ].join(" ")}
                  >
                    {h.type}
                  </span>
                  <span className="font-mono text-[10px] text-gray-700 truncate flex-1">
                    {(h.chatNodeId ?? h.workNodeId ?? h.sessionId).slice(0, 12)}
                    …
                  </span>
                </div>
                <div
                  className="text-[10px] text-gray-500 truncate"
                  title={h.cwd}
                >
                  📁 {basename(h.cwd) || h.cwd}
                </div>
                {h.preview && (
                  <div className="text-[10px] text-gray-600 mt-0.5 line-clamp-2">
                    {h.preview}
                  </div>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {jumpState.status === "done" && jumpState.truncated && (
        <div className="text-[10px] text-gray-400 italic px-1">
          {t("sidebar_search.truncated_hint")}
        </div>
      )}
    </div>
  );
}

function candidateKey(h: SearchHit): string {
  if (h.type === "session") return `s-${h.sessionId}`;
  if (h.type === "chatnode") return `c-${h.sessionId}-${h.chatNodeId}`;
  return `w-${h.sessionId}-${h.workNodeId}`;
}

function toJumpHit(h: SearchHit): JumpHit {
  if (h.type === "session") return { type: "session", sessionId: h.sessionId };
  if (h.type === "chatnode") {
    return {
      type: "chatnode",
      sessionId: h.sessionId,
      chatNodeId: h.chatNodeId ?? "",
    };
  }
  return {
    type: "worknode",
    sessionId: h.sessionId,
    workNodeId: h.workNodeId ?? "",
  };
}

function basename(p: string): string {
  const idx = p.lastIndexOf("/");
  if (idx === -1) return p;
  return p.slice(idx + 1) || p;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
