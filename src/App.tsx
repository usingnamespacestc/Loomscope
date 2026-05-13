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
import { DraftPanel } from "@/components/drill/DraftPanel";
import { DrillPanel } from "@/components/drill/DrillPanel";
import { Header } from "@/components/Header";
import { HookOnboardingModal } from "@/components/HookOnboardingModal";
import { InteractivePermissionBanner } from "@/components/InteractivePermissionBanner";
import { PermissionBanner } from "@/components/PermissionBanner";
import { TrashedSessionBanner } from "@/components/TrashedSessionBanner";
import { Sidebar } from "@/components/Sidebar";
import { useKeyboardNav } from "@/hooks/useKeyboardNav";
import { useStore } from "@/store/index";
import { chatFlowHash } from "@/utils/chatFlowSig";
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
  // v1.6 #182: draft session branch — `draft-<uuid>` activeId means
  // the user landed on the new-session modal's empty-prompt path. No
  // CC subprocess exists; the canvas shows a placeholder and the
  // right side hosts a draft-aware Composer (DraftPanel).
  const draftSession = useStore((s) => s.draftSession);
  const isDraft =
    !!activeId &&
    !!draftSession &&
    activeId === draftSession.id;

  useEffect(() => {
    if (activeId && !session) {
      void useStore.getState().loadSession(activeId);
    }
  }, [activeId, session]);

  // v1.1: load server-side preferences once on mount so global
  // settings (currently just `interactiveMode`) are available before
  // any write affordance renders. Other preference fields
  // (idleTimeoutMin / useApiKey / etc) are still fetched lazily by
  // SettingsModal; they don't gate UI elsewhere so a startup load
  // would be wasted.
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/preferences", {
          credentials: "same-origin",
        });
        if (!res.ok) return;
        const p = (await res.json()) as { interactiveMode?: boolean };
        if (typeof p.interactiveMode === "boolean") {
          useStore.getState().setInteractiveMode(p.interactiveMode);
        }
      } catch {
        // Fall back to default (interactiveMode=true). Better to
        // show controls than to lock the user out due to a
        // transient network blip on app load.
      }
    })();
  }, []);

  // CC TaskList: load on session activation, drop on switch-away.
  // The SSE handler below pushes refreshes via `kind: "tasks"`.
  useEffect(() => {
    if (!activeId) return;
    // v1.6 #182: draft id has no jsonl yet → skip task fetch.
    if (activeId.startsWith("draft-")) return;
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
    // v1.6 #182: draft session id has no server-side counterpart —
    // skip SSE attach + leave the live-status as idle until
    // commitDraftSession swaps in the real sid.
    if (activeId.startsWith("draft-")) {
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
        }
        // v2.1 PR D2 cutover: main-jsonl `invalidate` no longer
        // triggers a full refresh. Server's parallel `delta` channel
        // (PR D1) carries the actual chatflow changes; the gap
        // detector in applyChatFlowDelta + (PR D3's) drift hash
        // ping are the safety nets. `invalidate` still fires as an
        // activity signal (handled above by markSessionActivity)
        // but we drop the heavy 16.8 MB-per-event refresh.
        // 中: PR D2 切换。main invalidate 不再触发 full refresh，
        // delta 通道接管。activity 信号还在（liveness 还活），但
        // 16.8MB 重新拉取去掉了。
      } catch (err) {
        console.error("[loomscope] sse invalidate parse failed:", err);
      }
    });
    // EN (v2.1 PR D2): `delta` SSE event — semantic chatflow diff
    // pushed by the server-side delta engine (PR D1). Replaces the
    // old `invalidate` → full GET path for main-jsonl changes.
    //   - chatnode-added / chatnode-summary-updated / chatnode-removed
    //     patch the in-memory ChatFlow directly
    //   - checkpoint at end of each batch validates chatNodeCount
    //   - per-session seq tracking detects gaps → falls back to full
    //     refresh
    // 中: server 推的语义 delta，applyChatFlowDelta 直接 patch；
    // 监测 seq 缺号或 checkpoint count 不匹配时退回 refreshSession。
    es.addEventListener("delta", (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data) as {
          type: string;
          seq: number;
          [k: string]: unknown;
        };
        useStore.getState().applyChatFlowDelta(
          activeId,
          payload as Parameters<
            ReturnType<typeof useStore.getState>["applyChatFlowDelta"]
          >[1],
        );
      } catch (err) {
        console.error("[loomscope] sse delta parse failed:", err);
      }
    });
    // EN (v2.1 PR D3): drift-ping. Server periodically emits its
    // chatflow hash; client recomputes the same hash on local state
    // and forces a refreshSession if they diverge. Backstop for
    // reducer bugs that advance seq correctly but mutate state wrong.
    //
    // 中: drift 检测。客户端用同算法算本地 hash 跟 server 推的对，
    // 不一致就强制 refresh。reducer 漏 case / 静默漂时兜底。
    es.addEventListener("drift-ping", (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data) as {
          sessionId: string;
          seq: number;
          chatNodeCount: number;
          hash: string;
        };
        if (payload.sessionId !== activeId) return;
        const s = useStore.getState().sessions.get(activeId);
        if (!s?.chatFlow) return;
        const localCount = s.chatFlow.chatNodes.length;
        if (localCount !== payload.chatNodeCount) {
          console.warn(
            `[loomscope] drift detected on ${activeId}: server count ${payload.chatNodeCount} != local ${localCount}`,
          );
          void useStore.getState().refreshSession(activeId);
          return;
        }
        // Lazy hash: only compute when count matches (most common path
        // is "all good" so skip the hash compute when count already
        // disagrees).
        // 中: count 对得上才算 hash，常态省 CPU。
        const localHash = chatFlowHash(s.chatFlow.chatNodes);
        if (localHash !== payload.hash) {
          console.warn(
            `[loomscope] drift detected on ${activeId}: server hash ${payload.hash} != local ${localHash}`,
          );
          void useStore.getState().refreshSession(activeId);
        }
      } catch (err) {
        console.error("[loomscope] sse drift-ping parse failed:", err);
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
    // v∞.2: SDK channel events. SessionRegistry on the server emits
    // these whenever a turn enqueues / runs / completes. Three event
    // types — queue-state (snapshot), sdk-message (per-frame stream),
    // session-closed (registry dropped this entry).
    es.addEventListener("sdk-queue-state", (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data) as {
          sessionId: string;
          state: "idle" | "running";
          currentRun: { promptItemId: string; startedAt: number } | null;
          pendingPrompts: Array<{
            id: string;
            text: string;
            imageCount: number;
            priority: "now" | "next" | "later";
            createdAt: number;
          }>;
        };
        if (payload.sessionId !== activeId) return;
        useStore.getState().applySdkQueueState(activeId, {
          state: payload.state,
          currentRun: payload.currentRun,
          pendingPrompts: payload.pendingPrompts,
        });
      } catch (err) {
        console.error("[loomscope] sse sdk-queue-state parse failed:", err);
      }
    });
    es.addEventListener("sdk-session-closed", (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data) as {
          sessionId: string;
        };
        if (payload.sessionId !== activeId) return;
        useStore.getState().clearSdkSession(activeId);
        // v∞.3 PR1: also drop any pending canUseTool prompts —
        // server-side already rejected them; UI carcasses serve no
        // purpose and would be confusing if they linger.
        useStore.getState().clearCanUseToolPrompts(activeId);
      } catch {
        /* ignore */
      }
    });

    // v∞.3 PR1: SDK canUseTool browser-banner events. The server
    // emits `permission-prompt` when canUseTool fires for a tool
    // that has no saved rule; the browser shows a banner with
    // Allow / Always / Deny buttons. The banner POSTs the user's
    // decision to /api/sessions/:id/permission-prompts/:promptId/
    // decision; on success the prompt is removed from store
    // (optimistic clear + the matching `permission-prompt-resolved`
    // SSE event also cleans up).
    es.addEventListener("permission-prompt", (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data) as {
          sessionId: string;
          promptId: string;
          toolName: string;
          input: Record<string, unknown>;
          title?: string;
          displayName?: string;
          decisionReason?: string;
          blockedPath?: string;
        };
        if (payload.sessionId !== activeId) return;
        useStore.getState().addCanUseToolPrompt(activeId, {
          promptId: payload.promptId,
          toolName: payload.toolName,
          toolInput: payload.input,
          title: payload.title,
          displayName: payload.displayName,
          decisionReason: payload.decisionReason,
          blockedPath: payload.blockedPath,
          receivedAt: Date.now(),
        });
      } catch (err) {
        console.error("[loomscope] sse permission-prompt parse failed:", err);
      }
    });
    es.addEventListener("permission-prompt-resolved", (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data) as {
          sessionId: string;
          promptId: string;
          reason?: string;
        };
        if (payload.sessionId !== activeId) return;
        useStore.getState().removeCanUseToolPrompt(activeId, payload.promptId);
      } catch {
        /* ignore */
      }
    });
    // sdk-message: every SDKMessage frame. We don't keep a log here
    // (the jsonl file watcher path persists everything); we just bump
    // session activity so the running pulse stays lit even when
    // there's no jsonl-write between consecutive frames.
    //
    // Also doubles as the early-clear signal for any in-flight
    // respawn notice — the fresh Query produced output, so the
    // "spawning…" banner can come down even before the 10s timeout.
    es.addEventListener("sdk-message", (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data) as {
          type: string;
        };
        useStore.getState().markSessionActivity(activeId);
        useStore.getState().setRespawnNotice(activeId, null);
        // v2.0.1 PR A: rate_limit_event now routed via dedicated
        // `sdk-rate-limit` SSE event below — this comment marks the
        // spot where the older "TODO route specific types" intent
        // was finally honored.
        // 中: rate_limit_event 走专用 `sdk-rate-limit` 事件了，下面 handler。
        void payload; // other types still flow through here as opaque
      } catch {
        /* ignore */
      }
    });

    // EN (v2.0.1 PR A): dedicated rate-limit SSE event. Server emits
    // a parallel `sdk-rate-limit` whenever it sees an SDK
    // `rate_limit_event` frame (threshold crossings only — CC's
    // built-in EARLY_WARNING_CONFIGS fire at 75% / 90% utilization,
    // plus `rejected` at 100% and an `allowed` clear-event when the
    // window resets). API-key auth users never see these events;
    // they're gated upstream by `shouldProcessRateLimits(isClaudeAISubscriber())`.
    //
    // 中: 服务端见到 SDK rate_limit_event 时单发的事件。仅 Claude.ai
    // 订阅用户（Pro / Max / Max-x5）会触发；CC 内置阈值 75%/90%/100%。
    es.addEventListener("sdk-rate-limit", (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data) as {
          status: "allowed" | "allowed_warning" | "rejected";
          resetsAt?: number;
          rateLimitType?:
            | "five_hour"
            | "seven_day"
            | "seven_day_opus"
            | "seven_day_sonnet"
            | "overage";
          utilization?: number;
          surpassedThreshold?: number;
          receivedAt: number;
        };
        useStore.getState().applyRateLimitEvent(activeId, payload);
      } catch {
        /* ignore */
      }
    });

    // EN (v2.0.1 PR B): deferral state transitions. Server emits this
    // when the auto-defer engine arms (90% warning + setting on) or
    // disarms (timer fires / user clicks 立即重试 / rate-limit
    // cleared event). Banner above composer renders based on this.
    //
    // 中: deferral 状态切换。server 在 arm/disarm 时 emit；banner 用。
    es.addEventListener("sdk-deferral", (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data) as {
          sessionId: string;
          deferralUntilEpoch: number | null;
          reason: {
            utilization: number;
            rateLimitType: string;
            surpassedThreshold?: number;
            startedAt: number;
          } | null;
        };
        if (payload.sessionId !== activeId) return;
        useStore.getState().applyDeferralEvent(activeId, {
          deferralUntilEpoch: payload.deferralUntilEpoch,
          reason: payload.reason,
        });
      } catch {
        /* ignore */
      }
    });

    // sdk-respawn-notice: emitted by SessionRegistry's race-
    // mitigation path before close+respawn. Composer renders a brief
    // banner (see docs/dual-writer-race-mitigation.md) so the user
    // understands the small latency bump on this send.
    //
    // Auto-clear policy: 10s safety-net timeout in case the next
    // `sdk-message` frame doesn't arrive (failed spawn, abort, …).
    // The sdk-message handler clears earlier when output starts
    // flowing — typical case is the banner stays visible for ~300ms.
    es.addEventListener("sdk-respawn-notice", (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data) as {
          sessionId: string;
          reason: "per-send" | "staleness-detected";
        };
        if (payload.sessionId !== activeId) return;
        useStore.getState().setRespawnNotice(activeId, {
          startedAt: Date.now(),
          reason: payload.reason,
        });
        window.setTimeout(() => {
          // Only clear if it's still ours — a fresh notice could have
          // landed in the interim and we shouldn't clobber it.
          const cur = useStore
            .getState()
            .inflightBySession.get(activeId)?.respawnNotice;
          if (cur && cur.reason === payload.reason) {
            useStore.getState().setRespawnNotice(activeId, null);
          }
        }, 10_000);
      } catch (err) {
        console.error("[loomscope] sse sdk-respawn-notice parse failed:", err);
      }
    });

    es.addEventListener("hello", () => {
      // Belt-and-suspenders: some browsers fire onopen before the
      // hello frame arrives; mark open on either signal.
      useStore.getState().setLiveStatus("session", "open");
      // EN (v2.1 PR D5 revised 2026-05-13): hello = EventSource
      // (re)connect success signal. On reconnect, server's delta
      // snapshot has been reset (see sessions.ts unsubscribe path)
      // and it will re-emit ALL ChatNodes as `chatnode-added` on the
      // next chokidar fire. We reset `lastDeltaSeq` to null so those
      // re-emitted deltas are accepted as the new baseline instead
      // of gap-detecting.
      //
      // No refreshSession call — the re-emitted chatnode-added events
      // (with dedup-by-id in the reducer) will reconcile any state
      // missed during the disconnect. Avoids the 4-second-GET refresh
      // round-trip on every reconnect blip.
      //
      // Initial mount also fires hello; resetting null→null is a
      // no-op, so this is safe to run unconditionally.
      //
      // 中: hello = (重)连接成功。server snapshot 已重置（见
      // sessions.ts unsubscribe），所有 ChatNode 会重新 emit 当
      // added，我们 reset lastDeltaSeq=null 让那批新 seq 直接 baseline。
      // 不发 refresh——dedup-by-id 的 reducer 会让 added 流自然 reconcile
      // disconnect 期间漏的节点，省 4s GET 往返。初次挂载 null→null
      // 无 op，统一处理。
      const sessions = useStore.getState().sessions;
      const cur = sessions.get(activeId);
      if (cur && cur.lastDeltaSeq != null) {
        const next = new Map(sessions);
        next.set(activeId, { ...cur, lastDeltaSeq: null });
        useStore.setState({ sessions: next });
      }
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
          {isDraft && draftSession && <DraftMain cwd={draftSession.cwd} />}
          {activeId && !isDraft && session?.isLoading && <LoadingState />}
          {activeId && !isDraft && session?.error && (
            <ErrorState message={session.error} />
          )}
          {activeId && <PermissionBanner sessionId={activeId} />}
          {activeId && <InteractivePermissionBanner sessionId={activeId} />}
          {activeId && <TrashedSessionBanner sessionId={activeId} />}
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
        {isDraft && draftSession && (
          <DraftPanel sessionId={draftSession.id} cwd={draftSession.cwd} />
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

// v1.6 #182 draft mode: canvas-area placeholder shown while user has
// activated a `draft-<uuid>` session but hasn't sent a message yet.
// The DraftPanel on the right hosts the Composer; sending from there
// commits the draft to a real CC sid and this placeholder gets
// replaced by the normal ChatFlowCanvas on the same render tick.
function DraftMain({ cwd }: { cwd: string }) {
  const { t } = useTranslation();
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center"
      data-testid="draft-main"
    >
      <div className="text-6xl opacity-25 select-none">📝</div>
      <div className="text-xl font-semibold tracking-tight text-gray-700">
        {t("draft_main.title")}
      </div>
      <div className="max-w-md text-sm text-gray-500">
        {t("draft_main.subtitle")}
      </div>
      <div className="inline-flex items-center gap-1.5 rounded border border-gray-200 bg-white px-2.5 py-1 font-mono text-[11px] text-gray-600 shadow-sm">
        <span>📁</span>
        <span className="truncate max-w-[420px]" title={cwd}>
          {cwd}
        </span>
      </div>
    </div>
  );
}
