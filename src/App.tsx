// v0.2 layout: header above, sidebar left, canvas filling remaining area.
// v0.3: drill-down WorkFlow view replaces the main viewport when
// ``drillStack`` is non-empty. The chosen drill model (option C) means
// only one canvas type renders at a time — picked by ``viewMode``.
// Breadcrumb pinned top-left when in WorkFlow view to navigate back.
// v0.5: drillStack can hold mixed chatnode + subworkflow frames.
// v0.6 redo: subworkflow frames now resolve to a FULL sub-agent
// ChatFlow rendered recursively by ChatFlowCanvas (no more
// chatNodes[0] collapse + no amber multi-ChatNode banner). Drilling
// further into a sub-ChatFlow's ChatNode pushes another chatnode
// frame.
//
// Visual chrome per `design-visual-language.md` 视觉 token 章节.

import { useEffect, useMemo } from "react";

import { CanvasPanProvider } from "@/canvas/CanvasPanContext";
import { ChatFlowCanvas } from "@/canvas/ChatFlowCanvas";
import { WorkFlowCanvas } from "@/canvas/WorkFlowCanvas";
import { DrillPanel } from "@/components/drill/DrillPanel";
import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";
import { useKeyboardNav } from "@/hooks/useKeyboardNav";
import { useStore } from "@/store/index";
import {
  resolveDrillView,
  type DrillBreadcrumbItem,
} from "@/store/sessionSlice";

export default function App() {
  useKeyboardNav();
  const activeId = useStore((s) => s.activeSessionId);
  const session = useStore((s) => (activeId ? s.sessions.get(activeId) : null));
  // v0.8.1 #7: when the drill panel is in fullscreen mode, <main>
  // hides via display:none and the panel's flex:1 grows into the
  // canvas track. Sidebar stays visible.
  const drillPanelFullscreen = useStore((s) => s.drillPanelFullscreen);

  useEffect(() => {
    if (activeId && !session) {
      void useStore.getState().loadSession(activeId);
    }
  }, [activeId, session]);

  // Resolve which view to show. Sub-agent drill frames pull the
  // sub ChatFlow out of the cache, so the resolver returns null
  // (= ChatFlow view fallback) until the cache fills.
  const view = useMemo(() => {
    if (!session || !activeId) return { mode: "chatflow" as const };
    const resolved = resolveDrillView(session);
    if (!resolved) return { mode: "chatflow" as const };
    return resolved;
  }, [session, activeId]);

  // ChatNode-detail scope for DrillPanel: in workflow mode we expose
  // the owning ChatFlow (top-level or sub-agent) so a future click on
  // a sibling ChatNode resolves correctly. In chatflow / sub-chatflow
  // modes the visible ChatFlow is the scope.
  const drillScopeChatFlow =
    view.mode === "chatflow"
      ? session?.chatFlow ?? null
      : view.mode === "workflow"
        ? view.scopeChatFlow
        : view.chatFlow;
  const drilledChatNode = view.mode === "workflow" ? view.chatNode : null;

  return (
    <CanvasPanProvider>
    <div className="h-screen w-screen flex flex-col bg-gray-50 text-gray-900">
      <Header />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <main
          className={[
            "flex-1 min-w-0 relative bg-gray-100 overflow-hidden",
            drillPanelFullscreen ? "hidden" : "",
          ].join(" ")}
          data-testid="canvas-host"
        >
          {!activeId && <EmptyState />}
          {activeId && session?.isLoading && <LoadingState />}
          {activeId && session?.error && <ErrorState message={session.error} />}
          {/* v0.10 perf: top-level ChatFlowCanvas stays mounted across
              drill in/out — hidden via display:none when not the
              active view. Prevents the 187-card unmount/remount spike
              when user exits a WorkFlow drill. WorkFlowCanvas itself
              stays conditional (only ~30 WorkNodes per drill, fast to
              mount); sub-chatflow ChatFlowCanvas is also conditional
              since each drill renders a different sub-agent ChatFlow.
              React Flow's ResizeObserver re-measures cleanly when
              display flips from none → block. */}
          {activeId && session?.chatFlow && (
            <div
              className="absolute inset-0"
              style={{
                display: view.mode === "chatflow" ? "block" : "none",
              }}
            >
              <ChatFlowCanvas chatFlow={session.chatFlow} sessionId={activeId} />
            </div>
          )}
          {activeId && session?.chatFlow && view.mode === "workflow" && (
            <>
              <WorkFlowCanvas chatNode={view.chatNode} sessionId={activeId} />
              <DrillBreadcrumb sessionId={activeId} frames={view.frameLabels} />
            </>
          )}
          {activeId && session?.chatFlow && view.mode === "sub-chatflow" && (
            <>
              <ChatFlowCanvas chatFlow={view.chatFlow} sessionId={activeId} />
              <DrillBreadcrumb sessionId={activeId} frames={view.frameLabels} />
            </>
          )}
        </main>
        {activeId && session?.chatFlow && drillScopeChatFlow && (
          <DrillPanel
            sessionId={activeId}
            chatFlow={drillScopeChatFlow}
            viewMode={view.mode}
            drilledChatNode={drilledChatNode}
          />
        )}
      </div>
    </div>
    </CanvasPanProvider>
  );
}

function DrillBreadcrumb({
  sessionId,
  frames,
}: {
  sessionId: string;
  frames: DrillBreadcrumbItem[];
}) {
  const exitWorkflow = useStore((s) => s.exitWorkflow);
  const truncate = useStore((s) => s.truncateDrillStack);
  return (
    <nav
      data-testid="drill-breadcrumb"
      className="absolute left-3 top-3 z-20 flex flex-wrap items-center gap-1.5 rounded border border-gray-300 bg-white/90 px-2.5 py-1.5 text-xs text-gray-700 shadow-sm max-w-[80%]"
    >
      <button
        type="button"
        onClick={() => exitWorkflow(sessionId)}
        data-testid="exit-workflow"
        className="hover:text-blue-600 hover:underline transition-colors"
      >
        ← ChatFlow
      </button>
      {frames.map((frame, i) => {
        const isLast = i === frames.length - 1;
        const truncateTo = i + 1;
        return (
          <span key={i} className="flex items-center gap-1">
            <span className="text-gray-400">/</span>
            {isLast ? (
              <span
                className={[
                  "font-mono text-[11px]",
                  frame.isAutoCompact ? "text-purple-700 font-semibold" : "text-gray-900",
                ].join(" ")}
                title={frame.title}
                data-testid={`drill-breadcrumb-frame-${i}`}
              >
                {frame.label}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => truncate(sessionId, truncateTo)}
                className={[
                  "font-mono text-[11px] hover:text-blue-600 hover:underline transition-colors",
                  frame.isAutoCompact ? "text-purple-700 font-semibold" : "",
                ].join(" ")}
                title={frame.title}
                data-testid={`drill-breadcrumb-frame-${i}`}
              >
                {frame.label}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

function EmptyState() {
  const workspaces = useStore((s) => s.workspaces);
  const workspacesLoading = useStore((s) => s.workspacesLoading);
  const workspacesError = useStore((s) => s.workspacesError);
  const totalSessions = useMemo(
    () => workspaces.reduce((acc, w) => acc + w.sessionCount, 0),
    [workspaces],
  );
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="text-6xl opacity-30 select-none">⌬</div>
      <div className="space-y-1">
        <div className="text-2xl font-semibold tracking-tight text-gray-700">
          Loomscope
        </div>
        <div className="text-sm text-gray-500">
          Claude Code session 可视化阅读器
        </div>
      </div>
      {workspacesLoading ? (
        <div className="text-xs text-gray-400">扫描 ~/.claude/projects/…</div>
      ) : workspacesError ? (
        <div className="text-xs text-rose-600">
          扫描失败：<code className="font-mono">{workspacesError}</code>
        </div>
      ) : workspaces.length === 0 ? (
        <div className="space-y-1.5 text-xs text-gray-500">
          <div>没有在 <code className="font-mono text-gray-600">~/.claude/projects/</code> 找到 session</div>
          <div className="text-gray-400">用过 Claude Code 后这里会自动列出</div>
        </div>
      ) : (
        <div className="space-y-1.5 text-xs text-gray-500">
          <div>
            扫到 <span className="font-medium text-gray-700">{workspaces.length}</span> 个 workspace ·{" "}
            <span className="font-medium text-gray-700">{totalSessions}</span> 个 session
          </div>
          <div className="text-gray-400">
            ← 从左侧 sidebar 展开 workspace 选一个 session
          </div>
        </div>
      )}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-gray-500">
      <span className="inline-flex items-center gap-2 rounded bg-teal-100 px-3 py-1.5 text-sm font-medium text-teal-900">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-teal-500" />
        Parsing JSONL…
      </span>
      <span className="text-[11px] text-gray-400">Large sessions may take a few seconds.</span>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-rose-700">
      <span className="text-3xl">✗</span>
      <span className="text-sm font-medium">Failed to load session.</span>
      <code className="text-[11px] bg-rose-50 border border-rose-200 px-2 py-1 rounded font-mono text-rose-900 max-w-[480px] break-words">
        {message}
      </code>
    </div>
  );
}
