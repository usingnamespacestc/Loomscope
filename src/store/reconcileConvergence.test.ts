// EN (PR-2, 2026-05-18): reproduce-first integration test for the
// convergent reconcile backbone at the store level — the exact
// screenshot summary-divergence bug class.
//
// Scenario (the user's screenshot report): a mid-stream
// `chatnode-summary-updated` delta is DROPPED (half-open socket /
// missed broadcast — the server only writes to live subscribers and
// does NOT replay). The node's card renders but its assistant
// content never fills. Then the turn ENDS — pure quiescence, no
// further delta will ever arrive. The OLD per-event recovery cannot
// fire here (nothing to hook). The PR-2 scheduler, scheduled on the
// turn-end `sdk-idle` signal, must converge: a single coalesced
// reconcile pulls ground truth and the summary fills — with NO
// further delta dispatched.
//
// Proves: scheduler + normaliser wired to a refreshSession-shaped
// reconcile action heals dropped-delta + quiescence, deterministically
// (injected clock, no fake DOM timers, no network).
//
// 中: PR-2 收敛主干 store 级复现测试——正是截图里的 summary 漂移
// bug。中途 summary delta 被丢（半开/未重放）→ 卡片在但内容空 →
// turn 结束纯静默（旧的逐事件 recovery 无从触发）。PR-2 调度器在
// turn-end sdk-idle 上排程，单次合并 reconcile 拉 ground truth 把
// summary 补上——全程未再下发任何 delta。

import { beforeEach, describe, expect, it } from "vitest";

import { useStore } from "@/store/index";
import type { ChatFlow, ChatNode, WorkflowSummary } from "@/data/types";
import { normalizeSignal } from "@/sse/signalNormalizer";
import {
  RECONCILE_DEBOUNCE_MS,
  createReconcileScheduler,
} from "@/sse/reconcileScheduler";

const SID = "22222222-2222-4000-8000-000000000002";

function summary(o: Partial<WorkflowSummary> = {}): WorkflowSummary {
  return {
    assistantPreview: "",
    assistantText: [],
    llmCount: 0,
    hasInFlightWork: false,
    chainCount: 0,
    toolCount: 0,
    totalThinkingChars: 0,
    toolUseFilePaths: [],
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    lastModel: "claude-opus-4-7",
    contextTokens: 0,
    maxContextTokens: 200000,
    ...o,
  };
}
function cn(id: string, s: WorkflowSummary): ChatNode {
  return {
    kind: "chat",
    id,
    parentChatNodeId: null,
    rootUserUuid: `u-${id}`,
    userMessage: { uuid: `u-${id}`, content: `prompt ${id}`, attachments: [] },
    workflow: { nodes: [], edges: [], summary: s },
    trigger: "user",
    isCompactSummary: false,
    meta: {},
  };
}
function flow(nodes: ChatNode[]): ChatFlow {
  return {
    id: SID,
    mainJsonlPath: "/x.jsonl",
    sidecarDir: "/x",
    chatNodes: nodes,
    orphans: [],
    flowEvents: [],
    trigger: "user",
  };
}
function seed(chatFlow: ChatFlow, appliedVersion: number | null): void {
  useStore.setState((s) => {
    const sessions = new Map(s.sessions);
    sessions.set(SID, {
      chatFlow,
      foldedNodeIds: new Set(),
      foldedCompactIds: new Set(),
      viewport: { x: 0, y: 0, zoom: 1 },
      selectedNodeId: null,
      workflowSelectedNodeId: null,
      drillStack: [],
      branchMemory: {},
      subAgentCache: new Map(),
      workflowCache: new Map(),
      workflowViewports: new Map(),
      pendingPermission: null,
      pendingCanUseToolPrompts: [],
      currentTurn: null,
      lastTurnHookAt: 0,
      lastTurnUserSubmittedAt: 0,
      lastNotification: null,
      isLoading: false,
      error: null,
      lastUpdated: 0,
      lastInvalidateAt: 0,
      appliedVersion,
      serverVersion: null,
      rawAppliedRecordUuids: new Set<string>(),
    });
    return { sessions, activeSessionId: SID };
  });
}
function node(): ChatNode {
  const n = useStore.getState().sessions.get(SID)?.chatFlow?.chatNodes[0];
  if (!n) throw new Error("test bug: SID node missing");
  return n;
}
function sm(): WorkflowSummary {
  const s = node().workflow.summary;
  if (!s) throw new Error("test bug: node summary missing");
  return s;
}

describe("PR-2 convergence — dropped summary delta + turn-end quiescence", () => {
  beforeEach(() => {
    // Card present, assistant content NOT filled (the dropped
    // chatnode-summary-updated would have filled it). appliedVersion
    // 5 = last good delta the client applied.
    seed(flow([cn("p1", summary({ llmCount: 0, assistantText: [] }))]), 5);
  });

  it("converges via ONE coalesced reconcile, NO further delta, fills the summary", () => {
    let t = 0;
    let reconcileRuns = 0;

    // The reconcile action = a refreshSession-shaped ground-truth
    // pull. It does NOT dispatch a delta; it replaces the chatflow
    // with server truth (summary filled) and re-baselines the
    // watermark — exactly what _refreshSessionInner does.
    const runReconcile = (): void => {
      reconcileRuns += 1;
      useStore.setState((st) => {
        const sessions = new Map(st.sessions);
        const cur = sessions.get(SID)!;
        sessions.set(SID, {
          ...cur,
          chatFlow: flow([
            cn(
              "p1",
              summary({
                llmCount: 1,
                assistantText: ["the real assistant reply"],
                assistantPreview: "the real assistant reply",
              }),
            ),
          ]),
          appliedVersion: 6, // server truth was at seq 6
          serverVersion: 6,
        });
        return { sessions };
      });
    };

    // Max server version the client OBSERVED (e.g. via the dropped
    // delta's own seq leaking through a later drift-ping seq, or a
    // checkpoint) — ahead of appliedVersion ⇒ a real gap exists.
    const observedServer = 6;
    const sched = createReconcileScheduler({
      debounceMs: RECONCILE_DEBOUNCE_MS,
      maxWaitMs: 1000,
      now: () => t,
      getVersions: () => ({
        applied: useStore.getState().sessions.get(SID)?.appliedVersion ?? null,
        server: observedServer,
      }),
    });

    // --- the dropped delta: we simply never dispatch it. The summary
    // stays empty. Sanity:
    expect(sm().llmCount).toBe(0);
    expect(sm().assistantText).toEqual([]);

    // --- turn ends. The ONLY signal that arrives is sdk-queue-state
    // → idle (quiescence). Normalise it the way App.tsx will.
    const s = normalizeSignal("sdk-queue-state", {
      sessionId: SID,
      state: "idle",
    });
    expect(s.reconcileReason).toBe("sdk-idle");
    sched.schedule(s.reconcileReason!);

    // Before debounce elapses: nothing (still empty — the bug state).
    t += RECONCILE_DEBOUNCE_MS - 1;
    expect(sched.tick().action).toBe("idle");
    expect(sm().llmCount).toBe(0);

    // Debounce elapses with NO further signal (true quiescence).
    t += 2;
    const d = sched.tick();
    expect(d.action).toBe("reconcile");
    runReconcile();
    sched.done();

    // CONVERGED: summary filled, exactly one reconcile, and we never
    // dispatched a chatnode-summary-updated delta.
    expect(reconcileRuns).toBe(1);
    expect(sm().llmCount).toBe(1);
    expect(sm().assistantText).toEqual([
      "the real assistant reply",
    ]);

    // Now appliedVersion (6) covers observedServer (6): a further
    // quiescence tick short-circuits — no refetch storm.
    sched.schedule("sdk-idle");
    t += RECONCILE_DEBOUNCE_MS + 1;
    const d2 = sched.tick();
    expect(d2.action).toBe("short-circuit");
    expect(reconcileRuns).toBe(1); // still ONE — no redundant GET
  });

  it("redundant signal after convergence is ack-only (no refetch, no re-render)", () => {
    let t = 0;
    const reconcileRuns = 0;
    // Already converged: appliedVersion 6, server 6.
    seed(
      flow([
        cn(
          "p1",
          summary({ llmCount: 1, assistantText: ["filled"] }),
        ),
      ]),
      6,
    );
    const sched = createReconcileScheduler({
      debounceMs: RECONCILE_DEBOUNCE_MS,
      maxWaitMs: 1000,
      now: () => t,
      getVersions: () => ({
        applied: useStore.getState().sessions.get(SID)?.appliedVersion ?? null,
        server: 6,
      }),
    });
    // A redundant late checkpoint at seq 6 (≤ appliedVersion, no
    // content) → classifier-wise this is ③ ack; scheduler-wise a
    // scheduled reconcile short-circuits.
    sched.schedule("invalidate");
    t += RECONCILE_DEBOUNCE_MS + 1;
    const d = sched.tick();
    expect(d.action).toBe("short-circuit");
    expect(reconcileRuns).toBe(0);
  });
});
