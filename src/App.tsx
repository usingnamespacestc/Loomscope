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

import { useEffect, useMemo, useState } from "react";
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
import {
  SSE_STALE_MS,
  SSE_WATCHDOG_COOLDOWN_MS,
  SSE_WATCHDOG_TICK_MS,
  createSseWatchdog,
} from "@/sse/stalenessWatchdog";
import { useStore } from "@/store/index";
import { chatFlowHash } from "@/utils/chatFlowSig";
import {
  resolveDrillView,
  type DrillBreadcrumbItem,
} from "@/store/sessionSlice";

export default function App() {
  useKeyboardNav();
  // P5/P2/P3 (2026-05-17): bumping this forces the session
  // EventSource effect to tear down + recreate when the SSE
  // staleness watchdog detects a half-open (silently dead) socket.
  // 中: watchdog 检测到 SSE 半开时 +1，强制重建 EventSource。
  const [sseEpoch, setSseEpoch] = useState(0);
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

  // EN (2026-05-14, backlog B): eager-load git committed-files so the
  // 📤 PendingFilesChip ("截止本节点累积未提交") populates immediately
  // on session open — without this, the chip stays hidden until the
  // user explicitly opens the Git tab, and they see only 📁 (CC
  // trackedFileBackups cumulative index) which doesn't drop on commit.
  // After initial load, the SSE invalidate handler below force-refreshes
  // every 3s (debounced via committedFilesFetchedAt) so newly-detected
  // commits flow into pending counts without a Git tab toggle.
  // 中: 让 📤 chip 上来就有数据；后续 SSE invalidate 3s 防抖 force-
  // refresh 让新 commit 自动归零旧 pending。
  const committedFilesFetchedAt = useStore((s) =>
    activeId ? s.committedFilesFetchedAt.get(activeId) ?? 0 : 0,
  );
  const sessionLastInvalidateAt = useStore((s) =>
    activeId ? s.sessions.get(activeId)?.lastInvalidateAt ?? 0 : 0,
  );
  useEffect(() => {
    if (!activeId || activeId.startsWith("draft-")) return;
    if (!session?.chatFlow) return;
    const chatFlow = session.chatFlow;
    // Initial load (fetchedAt=0) OR invalidate > 3s past last fetch.
    if (
      committedFilesFetchedAt === 0 ||
      sessionLastInvalidateAt - committedFilesFetchedAt > 3000
    ) {
      void useStore
        .getState()
        .loadCommittedFiles(activeId, chatFlow, {
          force: committedFilesFetchedAt > 0,
        });
    }
  }, [
    activeId,
    session?.chatFlow,
    committedFilesFetchedAt,
    sessionLastInvalidateAt,
  ]);

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
    // EN (2026-05-16 fix): explicit reconnect detection. The previous
    // heuristic ("reconnect == cur.chatFlow truthy") had a hole: when
    // the SSE reconnects WHILE the initial GET /:id is still in-flight
    // (cur.chatFlow still null), the hello handler classified it as
    // "initial mount" and SKIPPED the recovery refreshSession — but
    // the disconnect window had already dropped that session's
    // chatnode-added delta (broadcast() only reaches live subscribers;
    // a reconnecting client misses in-flight events). Result: the
    // ChatNode stayed unfilled until the 30 s drift-ping — the user's
    // intermittent "发消息后有时候不自动刷出来". This flag classifies
    // by connection history, not by load state: the FIRST hello on
    // this EventSource is the initial connect (loadSession covers it);
    // every subsequent hello is a genuine reconnect → always recover.
    // 中: 用连接历史判定重连，不再用 chatFlow 是否加载来猜。第一个
    // hello = 初连（loadSession 兜底）；之后每个 hello = 重连，必 refresh。
    let helloSeen = false;
    // P5/P2/P3 (2026-05-17): SSE staleness watchdog. A half-open
    // socket (proxy idle-kill / NAT / sleep / starved upstream) fires
    // NO EventSource `error`, so the #327995e hello-reconnect never
    // triggers and `drift-ping` (itself an SSE event) is silent too —
    // the whole session freezes (stale content + stuck banner + stuck
    // running-time) until a manual refresh. The server pings every
    // 25 s; we wrap addEventListener so EVERY event (incl. ping/hello)
    // re-arms the watchdog, and a periodic tick force-reconnects +
    // resyncs when nothing has arrived for SSE_STALE_MS.
    // 中: SSE 半开时浏览器不报 error → 不重连。包裹 addEventListener
    // 让任何事件都喂 watchdog；超时强制重连 + 重新同步。
    const watchdog = createSseWatchdog({
      staleMs: SSE_STALE_MS,
      cooldownMs: SSE_WATCHDOG_COOLDOWN_MS,
    });
    // Non-reentrancy guard. The recovery awaits a full refreshSession
    // (heavy on a huge session); a plain effect-local flag is enough
    // because the sseEpoch bump re-runs the whole effect → a fresh
    // closure with recovering=false for the new connection.
    // 中: recovery 期间禁止再次触发；epoch 重建 effect 时新闭包自动
    // 复位，不需要 useRef。
    let recovering = false;
    const rawAdd = es.addEventListener.bind(es);
    es.addEventListener = ((
      type: string,
      cb: EventListenerOrEventListenerObject,
      o?: boolean | AddEventListenerOptions,
    ) =>
      rawAdd(
        type,
        (ev: Event) => {
          watchdog.noteEvent();
          return (cb as EventListener)(ev);
        },
        o,
      )) as typeof es.addEventListener;
    es.onopen = () => {
      watchdog.noteEvent();
      useStore.getState().setLiveStatus("session", "open");
    };
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
    // v2.2 PR E1: raw-record fast path. Server broadcasts these the
    // moment chokidar reports a jsonl append, before buildChatFlow
    // finishes. The store reducer spawns optimistic placeholder
    // ChatNodes (user records only in MVP); the slower ground-truth
    // `delta` event ~1-2s later replaces them in-place via the same
    // promptId.
    // 中: raw-record 通道。chokidar 看到 jsonl 写入立即广播，绕开
    // 1-2s 的 buildChatFlow；store reducer 造占位 ChatNode，后续
    // ground-truth delta 用同 promptId 原地替换。
    es.addEventListener("raw-records", (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data) as {
          sessionId: string;
          records: Parameters<
            ReturnType<typeof useStore.getState>["applyRawRecord"]
          >[1][];
        };
        if (payload.sessionId !== activeId) return;
        const apply = useStore.getState().applyRawRecord;
        for (const r of payload.records) apply(activeId, r);
      } catch (err) {
        console.error("[loomscope] sse raw-records parse failed:", err);
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
          /** v2.3 PR F2: "http" for terminal CC PreToolUse via the
           *  long-poll gate, undefined (treated as "sdk") for the
           *  Loomscope-spawned canUseTool path. Drives banner chip
           *  + decision endpoint routing. */
          source?: "sdk" | "http";
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
          source: payload.source ?? "sdk",
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
      // EN (v2.1 PR D5 revised again 2026-05-14): hello = EventSource
      // (re)connect success signal.
      //
      // History: an earlier revision (D5 final, commit 58b1fd2)
      // stopped resetting the server-side delta snapshot on SSE
      // unsubscribe, because 650+ chatnode-added re-emits on every
      // reconnect blip flooded the client reducer and stalled the UI.
      // That kept the snapshot warm but broke a previous assumption
      // this handler made: "reconnect → server re-emits → reducer's
      // id-dedup heals stale client state for free." With persistent
      // snapshots that re-emit no longer happens, so state missed
      // during the disconnect (e.g. chatnode-added arriving while the
      // SSE was reconnecting after a tsx-watch restart) is gone
      // forever from the delta stream. Drift-ping eventually catches
      // it (30 s), but drift's refresh path can fail silently (502 on
      // proxy timeout, etc.), and the user sees stale assistant text
      // or missing ChatNodes until a hard reload.
      //
      // Fix: on reconnect (not initial mount), kick a full refresh.
      // refreshSession is dedup'd, so a concurrent in-flight refresh
      // collapses; cost is one extra 4 s GET per reconnect — far
      // better than missing data. Initial mount is detected by
      // `chatFlow == null` (loadSession hasn't yet populated the
      // session); we skip the refresh because loadSession is already
      // about to do equivalent work.
      //
      // We still reset appliedVersion=null so any deltas arriving
      // before refresh completes seed a fresh baseline rather than
      // gap-detecting against the pre-disconnect seq.
      //
      // 中: hello = (重)连接成功。D5 final 之后 server 不再 reset
      // snapshot，因此 disconnect 期间漏掉的 chatnode-added 不会重
      // 发——只能靠主动 refresh 补。初挂载（chatFlow==null）跳过，
      // loadSession 已经在做了；重连时强制 refresh 修补 stale。
      // First hello on this EventSource = initial connect. loadSession
      // (the activeId effect) is already fetching the baseline, so a
      // refresh here would be redundant. Mark + return.
      // 中: 本 EventSource 的第一个 hello = 初连，loadSession 在跑，
      // 不重复 refresh。
      if (!helloSeen) {
        helloSeen = true;
        return;
      }
      // Any subsequent hello = genuine reconnect. The disconnect
      // window may have dropped delta/raw-records broadcasts (the
      // server only writes to live subscribers; it does NOT replay on
      // resubscribe — see PR D5/58b1fd2). Reset the delta-seq baseline
      // so post-refresh deltas don't gap-detect against a stale seq,
      // then force a full refresh to backfill whatever was missed.
      // refreshSession is dedup'd (concurrent in-flight collapses);
      // cost is one extra GET per reconnect, far cheaper than a
      // ChatNode silently missing its assistant content until the
      // 30 s drift-ping.
      // 中: 之后每个 hello = 真重连。重连窗口可能丢了 delta；重置
      // seq baseline + 强制 refresh 补全。refreshSession 自带去重。
      const sessions = useStore.getState().sessions;
      const cur = sessions.get(activeId);
      if (cur && cur.appliedVersion != null) {
        const next = new Map(sessions);
        next.set(activeId, { ...cur, appliedVersion: null });
        useStore.setState({ sessions: next });
      }
      void useStore.getState().refreshSession(activeId);
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
    // P5/P2/P3 (2026-05-17): watchdog poll. On a detected half-open
    // socket, recover in this strict order — REFRESH FIRST, then
    // recreate — and make the whole thing non-reentrant + awaited:
    //
    //   1. clear pendingPermission + currentTurn — their clearing
    //      cc-hook events (PostToolUse/Stop/Denied) may be exactly
    //      what was missed in the dark window; leaving them keeps the
    //      banner / running-time stuck (the core P5 symptom). Cheap.
    //   2. await refreshSession — pull ground truth (incl. any turns
    //      whose deltas were missed). This RECONCILES; we deliberately
    //      do NOT null appliedVersion (the old code did): the explicit
    //      refresh already gets ground truth, and the natural seq-gap
    //      detector elsewhere will refresh again if a later delta
    //      still doesn't line up — nulling just FORCED a second heavy
    //      rebuild, compounding jank on huge sessions.
    //   3. only AFTER the refresh resolves: close + recreate the ES
    //      (epoch bump) so live events resume on a fresh socket.
    //
    // `recovering` makes this run AT MOST ONCE until it completes, and
    // the watchdog's own cooldownMs bars another trip for 60 s. On a
    // genuine half-open socket the server is idle so refreshSession
    // returns fast (one-time cost). On a huge BUSY session a misfire
    // costs exactly one extra refresh — bounded, never a storm. This
    // is the fix for the sse_longconv regression where the recovery
    // janked → re-tripped → storm → all appends lost.
    // 中: 半开恢复严格顺序——先 await refreshSession 补全（不再清
    // appliedVersion，避免二次重建），再重建 EventSource；recovering +
    // cooldown 保证一次 trip 最多一次 recovery，杜绝大 session 风暴。
    const watchdogTimer = window.setInterval(() => {
      if (recovering || !watchdog.check()) return;
      recovering = true;
      // eslint-disable-next-line no-console
      console.warn(
        `[loomscope] SSE silent > ${SSE_STALE_MS}ms — assuming half-open, refresh-then-reconnect`,
      );
      const st = useStore.getState();
      const sessions = st.sessions;
      const cur = sessions.get(activeId);
      if (cur) {
        const next = new Map(sessions);
        next.set(activeId, {
          ...cur,
          pendingPermission: null,
          currentTurn: null,
        });
        useStore.setState({ sessions: next });
      }
      st.setLiveStatus("session", "error");
      void st
        .refreshSession(activeId)
        .catch(() => {
          /* refreshSession swallows its own errors; ignore */
        })
        .finally(() => {
          watchdog.reset();
          es.close();
          setSseEpoch((e) => e + 1); // re-run effect → fresh EventSource
        });
    }, SSE_WATCHDOG_TICK_MS);
    return () => {
      window.clearInterval(watchdogTimer);
      es.close();
      useStore.getState().setLiveStatus("session", "idle");
    };
  }, [activeId, sseEpoch]);

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
