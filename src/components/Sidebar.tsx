// Left-rail session manager. VS Code-style collapsible tree:
//   workspace (cwd) → click ▸ to expand → list of sessions sorted by mtime.
// Click a session row → set as active → canvas loads it.

import { useEffect } from "react";

import { useStore } from "@/store/index";

export function Sidebar() {
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
    // Initial load only — re-fetching on empty would loop forever when the
    // user genuinely has no sessions. Manual refresh available via the ⟳
    // button.
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (collapsed) {
    return (
      <div className="bg-gray-50 border-r border-gray-200 flex flex-col items-center py-3" style={{ width: 36 }}>
        <button
          className="text-gray-500 hover:text-gray-900 text-xs"
          title="Expand sidebar"
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
      <div className="px-3 py-2 border-b border-gray-200 flex items-center justify-between">
        <span className="text-xs font-semibold tracking-wide text-gray-700">SESSIONS</span>
        <div className="flex items-center gap-2">
          <button
            className="text-gray-400 hover:text-gray-700 text-xs"
            title="Refresh workspaces"
            onClick={() => void refresh()}
          >
            ⟳
          </button>
          <button
            className="text-gray-400 hover:text-gray-700 text-xs"
            title="Collapse sidebar"
            onClick={() => useStore.getState().toggleSidebar()}
          >
            ◀
          </button>
        </div>
      </div>

      {loading && <div className="px-3 py-2 text-xs text-gray-400">Loading workspaces…</div>}
      {error && (
        <div className="px-3 py-2 text-xs text-red-600 break-words" data-testid="sidebar-error">
          {error}
        </div>
      )}
      {!loading && !error && workspaces.length === 0 && (
        <div className="px-3 py-2 text-xs text-gray-400">
          No CC sessions found in <code>~/.claude/projects/</code>.
        </div>
      )}

      <div className="overflow-y-auto flex-1">
        <ul className="text-xs">
          {workspaces.map((ws) => {
            const isOpen = expanded.has(ws.cwd);
            const sessions = sessionsByCwd.get(ws.cwd);
            return (
              <li key={ws.cwd} className="border-b border-gray-100">
                <button
                  className="w-full flex items-center gap-1 px-2 py-1 hover:bg-gray-100 text-left"
                  onClick={() => toggleExpanded(ws.cwd)}
                  data-testid={`workspace-row-${ws.cwd}`}
                >
                  <span className="text-gray-400 w-3 inline-block">{isOpen ? "▾" : "▸"}</span>
                  <span className="font-mono text-[11px] text-gray-800 truncate flex-1" title={ws.cwd}>
                    {basename(ws.cwd)}
                  </span>
                  <span className="text-[10px] text-gray-400">{ws.sessionCount}</span>
                </button>
                {isOpen && (
                  <ul className="bg-white" data-testid={`session-list-${ws.cwd}`}>
                    {!sessions && (
                      <li className="px-6 py-1 text-[11px] text-gray-400">Loading…</li>
                    )}
                    {sessions?.length === 0 && (
                      <li className="px-6 py-1 text-[11px] text-gray-400">(no sessions)</li>
                    )}
                    {sessions?.map((s) => (
                      <li key={s.sessionId}>
                        <button
                          className={[
                            "w-full text-left px-6 py-1 hover:bg-blue-50",
                            activeId === s.sessionId ? "bg-blue-100 text-blue-900" : "text-gray-700",
                          ].join(" ")}
                          onClick={() => setActive(s.sessionId)}
                          data-testid={`session-row-${s.sessionId}`}
                          title={`${s.sessionId} · ${formatBytes(s.fileSize)} · ${s.messageCount} records`}
                        >
                          <div className="truncate">{s.title}</div>
                          <div className="text-[10px] text-gray-400 flex justify-between">
                            <span className="font-mono">{s.sessionId.slice(0, 8)}</span>
                            <span>{formatBytes(s.fileSize)}</span>
                          </div>
                        </button>
                      </li>
                    ))}
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
