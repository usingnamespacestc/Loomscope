// EN (v2.1 PR D2): unit tests for the client-side applyChatFlowDelta
// reducer. Drives the store directly with synthetic delta payloads
// and asserts the resulting ChatFlow state + lastDeltaSeq.
//
// 中: applyChatFlowDelta 单测。直接 dispatch 合成 delta，看 store
// 状态 + seq 走得对不对。

import { beforeEach, describe, expect, it, vi } from "vitest";

import { useStore } from "@/store/index";
import type {
  ChatFlow,
  ChatNode,
  WorkflowSummary,
} from "@/data/types";
import type { ChatFlowDeltaEvent } from "@/store/types";

const SID = "11111111-1111-4000-8000-000000000001";

function summary(o: Partial<WorkflowSummary> = {}): WorkflowSummary {
  return {
    assistantPreview: "",
    assistantText: [],
    llmCount: 1,
    hasInFlightWork: false,
    chainCount: 1,
    toolCount: 0,
    fileTouchCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    lastModel: "claude-opus-4-7",
    contextTokens: 0,
    maxContextTokens: 200000,
    ...o,
  };
}

function cn(id: string, parent: string | null = null): ChatNode {
  return {
    kind: "chat",
    id,
    parentChatNodeId: parent,
    rootUserUuid: `u-${id}`,
    userMessage: { uuid: `u-${id}`, content: `prompt ${id}`, attachments: [] },
    workflow: { nodes: [], edges: [], summary: summary() },
    trigger: "user",
    isCompactSummary: false,
    meta: {},
  };
}

function seed(chatFlow: ChatFlow, lastDeltaSeq: number | null = null): void {
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
      lastDeltaSeq,
      rawAppliedRecordUuids: new Set<string>(),
    });
    return { sessions, activeSessionId: SID };
  });
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

beforeEach(() => {
  useStore.setState({ sessions: new Map(), activeSessionId: null });
  // Stub refreshSession so gap-detection tests don't hit network.
  // 中: gap 检测会调 refreshSession；存根掉避免网络。
  useStore.setState({
    refreshSession: vi.fn(async () => {}),
  } as Partial<ReturnType<typeof useStore.getState>>);
});

describe("applyChatFlowDelta", () => {
  it("first delta after fresh baseline seeds lastDeltaSeq without gap", () => {
    seed(flow([cn("a")]));
    useStore.getState().applyChatFlowDelta(SID, {
      type: "chatnode-added",
      seq: 42,
      chatNode: cn("b", "a"),
    } as ChatFlowDeltaEvent);
    const s = useStore.getState().sessions.get(SID);
    expect(s?.chatFlow?.chatNodes.map((c) => c.id)).toEqual(["a", "b"]);
    expect(s?.lastDeltaSeq).toBe(42);
    expect(useStore.getState().refreshSession).not.toHaveBeenCalled();
  });

  it("chatnode-added: appends new ChatNode", () => {
    seed(flow([cn("a")]));
    useStore.getState().applyChatFlowDelta(SID, {
      type: "chatnode-added",
      seq: 1,
      chatNode: cn("b", "a"),
    });
    const cf = useStore.getState().sessions.get(SID)?.chatFlow;
    expect(cf?.chatNodes.map((c) => c.id)).toEqual(["a", "b"]);
    expect(useStore.getState().sessions.get(SID)?.lastDeltaSeq).toBe(1);
  });

  it("chatnode-added: dedups when id already present (replace semantics)", () => {
    seed(flow([cn("a")]));
    const updated = { ...cn("a"), userMessage: { uuid: "u-a", content: "updated", attachments: [] } };
    useStore.getState().applyChatFlowDelta(SID, {
      type: "chatnode-added",
      seq: 1,
      chatNode: updated,
    });
    const cf = useStore.getState().sessions.get(SID)?.chatFlow;
    expect(cf?.chatNodes.length).toBe(1);
    expect(cf?.chatNodes[0].userMessage.content).toBe("updated");
  });

  it("chatnode-summary-updated: patches workflow.summary in place", () => {
    seed(flow([cn("a")]));
    useStore.getState().applyChatFlowDelta(SID, {
      type: "chatnode-summary-updated",
      seq: 1,
      chatNodeId: "a",
      summary: summary({ llmCount: 5, inputTokens: 999 }),
    });
    const cf = useStore.getState().sessions.get(SID)?.chatFlow;
    expect(cf?.chatNodes[0].workflow.summary?.llmCount).toBe(5);
    expect(cf?.chatNodes[0].workflow.summary?.inputTokens).toBe(999);
  });

  it("chatnode-summary-updated: unknown id triggers refreshSession (drift)", () => {
    seed(flow([cn("a")]));
    useStore.getState().applyChatFlowDelta(SID, {
      type: "chatnode-summary-updated",
      seq: 1,
      chatNodeId: "zzz-not-there",
      summary: summary(),
    });
    expect(useStore.getState().refreshSession).toHaveBeenCalledWith(SID);
  });

  it("chatnode-removed: drops by id", () => {
    seed(flow([cn("a"), cn("b", "a"), cn("c", "b")]));
    useStore.getState().applyChatFlowDelta(SID, {
      type: "chatnode-removed",
      seq: 1,
      chatNodeId: "b",
    });
    const cf = useStore.getState().sessions.get(SID)?.chatFlow;
    expect(cf?.chatNodes.map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("checkpoint: chatNodeCount match → no refresh", () => {
    seed(flow([cn("a"), cn("b", "a")]));
    useStore.getState().applyChatFlowDelta(SID, {
      type: "checkpoint",
      seq: 1,
      chatNodeCount: 2,
    });
    expect(useStore.getState().refreshSession).not.toHaveBeenCalled();
    expect(useStore.getState().sessions.get(SID)?.lastDeltaSeq).toBe(1);
  });

  it("checkpoint: chatNodeCount mismatch → refreshSession", () => {
    seed(flow([cn("a")])); // local has 1
    useStore.getState().applyChatFlowDelta(SID, {
      type: "checkpoint",
      seq: 1,
      chatNodeCount: 5, // server says 5
    });
    expect(useStore.getState().refreshSession).toHaveBeenCalledWith(SID);
  });

  it("gap detection: seq skip triggers refreshSession", () => {
    seed(flow([cn("a")]), 5); // last applied = 5
    useStore.getState().applyChatFlowDelta(SID, {
      type: "chatnode-added",
      seq: 7, // expected 6, got 7
      chatNode: cn("b", "a"),
    });
    expect(useStore.getState().refreshSession).toHaveBeenCalledWith(SID);
    // Don't apply on gap — chatNodes unchanged.
    // 中: gap 时不应用 delta，保持原状态等 refresh。
    expect(useStore.getState().sessions.get(SID)?.chatFlow?.chatNodes.length).toBe(1);
  });

  it("strict +1 enforcement after baseline", () => {
    seed(flow([cn("a")]));
    useStore.getState().applyChatFlowDelta(SID, {
      type: "chatnode-added",
      seq: 10,
      chatNode: cn("b", "a"),
    });
    // Next: seq 11 OK
    useStore.getState().applyChatFlowDelta(SID, {
      type: "chatnode-added",
      seq: 11,
      chatNode: cn("c", "b"),
    });
    expect(useStore.getState().sessions.get(SID)?.chatFlow?.chatNodes.length).toBe(3);
    expect(useStore.getState().refreshSession).not.toHaveBeenCalled();
  });

  it("apply when session has no chatFlow yet → triggers refreshSession", () => {
    useStore.setState((s) => {
      const sessions = new Map(s.sessions);
      sessions.set(SID, {
        chatFlow: null,
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
        lastDeltaSeq: null,
      });
      return { sessions, activeSessionId: SID };
    });
    useStore.getState().applyChatFlowDelta(SID, {
      type: "chatnode-added",
      seq: 1,
      chatNode: cn("a"),
    });
    expect(useStore.getState().refreshSession).toHaveBeenCalledWith(SID);
  });
});
