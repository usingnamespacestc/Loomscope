// Left-rail session manager. VS Code-style collapsible tree:
//   workspace (cwd) → click ▸ to expand → list of sessions sorted by mtime.
// Click a session row → set as active → canvas loads it.
//
// Visual chrome per `design-visual-language.md` 视觉 token:
//   - 📁 folder emoji (matches Agentloom convention)
//   - hover:bg-blue-50 row accent
//   - active session gets blue left border
//   - section header tracking-wide uppercase

import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { useStore } from "@/store/index";

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

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

      {/* Workspace tree */}
      <div className="overflow-y-auto flex-1">
        <ul>
          {workspaces.map((ws) => {
            const isOpen = expanded.has(ws.cwd);
            const sessions = sessionsByCwd.get(ws.cwd);
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
                  <span className="text-[10px] text-gray-400 font-mono">{ws.sessionCount}</span>
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
                            <div className="truncate text-[11px]">{s.title}</div>
                            <div className="text-[10px] text-gray-400 flex justify-between mt-0.5">
                              <span className="font-mono">{s.sessionId.slice(0, 8)}</span>
                              <span className="font-mono">{formatBytes(s.fileSize)}</span>
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
      </div>
    </aside>
  );
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
