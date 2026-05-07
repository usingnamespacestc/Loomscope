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
import { useTranslation } from "react-i18next";

import { CanvasPanProvider } from "@/canvas/CanvasPanContext";
import { WorkFlowPanProvider } from "@/canvas/WorkFlowPanContext";
import { ConversationScrollProvider } from "@/canvas/ConversationScrollContext";
import { ChatFlowCanvas } from "@/canvas/ChatFlowCanvas";
import { WorkFlowCanvas } from "@/canvas/WorkFlowCanvas";
import { TaskListPanel } from "@/components/TaskListPanel";
import { SessionSearchBar } from "@/components/SessionSearchBar";
import { DrillPanel } from "@/components/drill/DrillPanel";
import { Header } from "@/components/Header";
import { HookOnboardingModal } from "@/components/HookOnboardingModal";
import { PermissionBanner } from "@/components/PermissionBanner";
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

  // CC TaskList: load on session activation, drop on switch-away.
  // The SSE handler below pushes refreshes via `kind: "tasks"`.
  useEffect(() => {
    if (!activeId) return;
    void useStore.getState().loadTasks(activeId);
    return () => {
      // Don't clear on unmount — user may switch back; cache survives.
      // (clearTasks is exposed for explicit session-removal flows.)
    };
  }, [activeId]);

  // v0.9 file-tail spike: subscribe to the active session's SSE event
  // stream. On `invalidate`, call refreshSession — re-fetches lite
  // ChatFlow + clears workflowCache so the lazy hooks pull fresh.
  // EventSource auto-reconnects on transient network drops; we only
  // need to tear down on activeSession change.
  //
  // Liveness state machine (used by Header indicator):
  //   no activeId → channel stays 'idle'
  //   constructed → 'connecting'
  //   onopen / hello received → 'open'
  //   onerror → 'error' (browser will auto-retry; we don't reconstruct)
  useEffect(() => {
    if (!activeId) {
      useStore.getState().setLiveStatus("session", "idle");
      return;
    }
    useStore.getState().setLiveStatus("session", "connecting");
    const url = `/api/sessions/${activeId}/events`;
    const es = new EventSource(url);
    es.onopen = () => useStore.getState().setLiveStatus("session", "open");
    es.addEventListener("invalidate", (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data) as {
          sessionId: string;
          // v0.9.1: server now classifies the change source. Older
          // payloads without `kind` are treated as main (back compat
          // for any in-flight stream during deploy).
          //
          // v0.11: `tasks` added — the per-session
          // `~/.claude/tasks/<sid>/*.json` directory changed.
          kind?: "main" | "subagent" | "tasks";
          agentId?: string;
          subdir?: string | null;
        };
        if (payload.sessionId !== activeId) return;
        // EN: bump session activity timestamp so liveness hooks
        // (useSessionLiveness) flip into active state. Both main
        // and subagent invalidates count as "session is alive".
        // 中: 任何一种 invalidate 都算 session 活跃信号；让 liveness
        // hook 进入 active 显示动画。Task list churn alone is
        // not a session-running signal — skip the activity bump.
        if (payload.kind !== "tasks") {
          useStore.getState().markSessionActivity(activeId);
        }
        if (payload.kind === "tasks") {
          void useStore.getState().refreshTasks(activeId);
        } else if (payload.kind === "subagent" && payload.agentId) {
          void useStore
            .getState()
            .refreshSubAgent(
              activeId,
              payload.agentId,
              payload.subdir ?? undefined,
            );
        } else {
          void useStore.getState().refreshSession(activeId);
        }
      } catch (err) {
        console.error("[loomscope] sse invalidate parse failed:", err);
      }
    });
    // v∞.0 PR 2: CC settings.json hook fires reach us via the
    // hookSseForwarder → sseHub bridge as a `cc-hook` event.
    // Most events are just activity signals (file-watch refresh
    // covers the data-shape changes anyway); the load-bearing
    // branch is PermissionRequest, which never appears in jsonl
    // and would otherwise be invisible.
    es.addEventListener("cc-hook", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as {
          event: string;
          payload: {
            session_id: string;
            transcript_path?: string;
            cwd?: string;
            permission_mode?: string;
            agent_id?: string;
            agent_type?: string;
            extras: Record<string, unknown>;
          };
        };
        if (data.payload.session_id !== activeId) return;
        useStore.getState().applyCcHookEvent(activeId, data.event, data.payload);
      } catch (err) {
        console.error("[loomscope] sse cc-hook parse failed:", err);
      }
    });
    es.addEventListener("hello", () => {
      // Belt-and-suspenders: some browsers fire onopen before the
      // hello frame arrives; mark open on either signal.
      useStore.getState().setLiveStatus("session", "open");
    });
    es.addEventListener("ping", () => {
      // Heartbeat — no-op.
    });
    es.onerror = () => {
      useStore.getState().setLiveStatus("session", "error");
      // EventSource auto-retries; we just log so devtools shows the
      // error rather than silent reconnect attempts.
      // eslint-disable-next-line no-console
      console.warn("[loomscope] sse error (EventSource will auto-retry)");
    };
    return () => {
      es.close();
      useStore.getState().setLiveStatus("session", "idle");
    };
  }, [activeId]);

  // v0.9.1: workspace-level SSE. Single global connection (lifetime =
  // app lifetime), independent of activeSession. On workspace-changed,
  // refetch the workspace summary list and any expanded session
  // listings (lazy-loaded sublists in the sidebar). New sessions
  // appear without manual refresh; deleted sessions disappear.
  useEffect(() => {
    useStore.getState().setLiveStatus("workspaces", "connecting");
    const es = new EventSource("/api/workspaces/events");
    es.onopen = () => useStore.getState().setLiveStatus("workspaces", "open");
    es.addEventListener("workspace-changed", (ev) => {
      const store = useStore.getState();
      // v0.10 收尾: when a session jsonl was unlinked from disk, drop
      // its in-memory state + GC its per-session localStorage entries.
      // Payload shape from `workspaceWatcher.ts`:
      //   { reason: "add" | "remove", sessionId, projectDir, path }
      // Best-effort parse — old/short payloads just skip the GC.
      try {
        const payload = JSON.parse((ev as MessageEvent).data ?? "{}") as {
          reason?: string;
          sessionId?: string;
        };
        if (payload.reason === "remove" && typeof payload.sessionId === "string") {
          store.removeSession(payload.sessionId);
        }
      } catch {
        // ignore — the refresh below still keeps the sidebar correct
      }
      void store.refreshWorkspaces();
      // Also refresh any expanded workspace's session list — the new
      // (or removed) jsonl might belong to one of them, and a fresh
      // listSessions reflects the current filesystem.
      for (const cwd of store.expandedCwds) {
        void store.loadSessions(cwd);
      }
    });
    es.addEventListener("hello", () => {
      useStore.getState().setLiveStatus("workspaces", "open");
    });
    es.addEventListener("ping", () => {});
    es.onerror = () => {
      useStore.getState().setLiveStatus("workspaces", "error");
      // eslint-disable-next-line no-console
      console.warn("[loomscope] workspaces sse error (auto-retry)");
    };
    return () => {
      es.close();
      useStore.getState().setLiveStatus("workspaces", "idle");
    };
  }, []);

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
    <WorkFlowPanProvider>
    <ConversationScrollProvider>
    <div className="h-screen w-screen flex flex-col bg-gray-50 text-gray-900">
      <Header />
      <HookOnboardingModal />
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
          {activeId && <PermissionBanner sessionId={activeId} />}
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
          {activeId && session?.chatFlow && (
            <TaskListPanel sessionId={activeId} />
          )}
          {activeId && session?.chatFlow && (
            <SessionSearchBar sessionId={activeId} />
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
    </ConversationScrollProvider>
    </WorkFlowPanProvider>
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
  const { t } = useTranslation();
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
        {t("breadcrumb.back_to_chatflow")}
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
  const { t } = useTranslation();
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
          {t("empty_state.subtitle")}
        </div>
      </div>
      {workspacesLoading ? (
        <div className="text-xs text-gray-400">{t("empty_state.scanning")}</div>
      ) : workspacesError ? (
        <div className="text-xs text-rose-600">
          {t("empty_state.scan_failed")}<code className="font-mono">{workspacesError}</code>
        </div>
      ) : workspaces.length === 0 ? (
        <div className="space-y-1.5 text-xs text-gray-500">
          <div>{t("empty_state.no_sessions_found")} <code className="font-mono text-gray-600">{t("empty_state.no_sessions_path")}</code> {t("empty_state.no_sessions_suffix")}</div>
          <div className="text-gray-400">{t("empty_state.no_sessions_hint")}</div>
        </div>
      ) : (
        <div className="space-y-1.5 text-xs text-gray-500">
          <div>
            {t("empty_state.found_summary_workspaces")} <span className="font-medium text-gray-700">{workspaces.length}</span> {t("empty_state.found_summary_unit_workspace")}{" "}
            <span className="font-medium text-gray-700">{totalSessions}</span> {t("empty_state.found_summary_unit_session")}
          </div>
          <div className="text-gray-400">
            {t("empty_state.pick_hint")}
          </div>
        </div>
      )}
    </div>
  );
}

function LoadingState() {
  const { t } = useTranslation();
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-gray-500">
      <span className="inline-flex items-center gap-2 rounded bg-teal-100 px-3 py-1.5 text-sm font-medium text-teal-900">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-teal-500" />
        {t("loading_state.parsing")}
      </span>
      <span className="text-[11px] text-gray-400">
        {t("loading_state.large_session_hint")}
      </span>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  const { t } = useTranslation();
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-rose-700">
      <span className="text-3xl">✗</span>
      <span className="text-sm font-medium">{t("error_state.failed_to_load")}</span>
      <code className="text-[11px] bg-rose-50 border border-rose-200 px-2 py-1 rounded font-mono text-rose-900 max-w-[480px] break-words">
        {message}
      </code>
    </div>
  );
}
