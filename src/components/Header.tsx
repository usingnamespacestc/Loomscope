// Top bar surfaces the active session's metadata. v0.2 just text;
// settings (⚙) / help (❓) icons land in v0.4.

import { useStore } from "@/store/index";

export function Header() {
  const activeId = useStore((s) => s.activeSessionId);
  const session = useStore((s) => (activeId ? s.sessions.get(activeId) : null));
  const cf = session?.chatFlow ?? null;

  return (
    <header
      className="border-b border-gray-200 bg-white flex items-center justify-between px-4"
      style={{ height: 44 }}
      data-testid="header"
    >
      <div className="flex items-center gap-3">
        <span className="text-sm font-semibold tracking-tight text-gray-900">Loomscope</span>
        {cf ? (
          <span className="text-[11px] text-gray-500 flex items-center gap-3 font-mono">
            <span title="cwd">📁 {cf.cwd ?? "—"}</span>
            <span title="git branch">⌥ {cf.gitBranch ?? "—"}</span>
            <span title="time range">
              ⏱ {short(cf.createdAt)} → {short(cf.lastUpdatedAt)}
            </span>
            <span title="path" className="truncate max-w-[260px]">
              {cf.mainJsonlPath}
            </span>
          </span>
        ) : (
          <span className="text-xs text-gray-400">Pick a session →</span>
        )}
      </div>

      <div className="flex items-center gap-3 text-xs text-gray-400">
        {session?.isLoading && <span className="animate-pulse">loading…</span>}
        {session?.error && <span className="text-red-600">{session.error}</span>}
        {cf && <span className="font-mono">{cf.chatNodes.length} ChatNodes</span>}
      </div>
    </header>
  );
}

function short(iso: string | undefined): string {
  if (!iso) return "—";
  // strip seconds + Z to keep header tight: 2026-05-02T16:38
  return iso.slice(0, 16).replace("T", " ");
}
