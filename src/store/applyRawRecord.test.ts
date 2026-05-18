// EN (v2.2 PR E1): unit tests for the raw-record fast path reducer.
// Drives the store directly with synthetic RawRecord payloads + asserts
// the placeholder ChatNode shape / dedup behaviour.
//
// 中: applyRawRecord 单测。模拟服务端推过来的 raw record，检查占位
// ChatNode 生成 / dedup / 各种过滤是否正确。

import { beforeEach, describe, expect, it } from "vitest";

import type { ChatFlow, ChatNode } from "@/data/types";
import type { RawRecord } from "@/parse/raw-record";
import { useStore } from "@/store/index";

const SID = "11111111-1111-4000-8000-000000000001";

function cn(id: string): ChatNode {
  return {
    kind: "chat",
    id,
    parentChatNodeId: null,
    rootUserUuid: `u-${id}`,
    userMessage: { uuid: `u-${id}`, content: `prompt ${id}`, attachments: [] },
    workflow: {
      nodes: [],
      edges: [],
      summary: {
        assistantPreview: "",
        assistantText: [],
        llmCount: 0,
        hasInFlightWork: false,
        chainCount: 0,
        toolCount: 0,
        totalThinkingChars: 0,
        contextTokens: 0,
        maxContextTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: null,
        toolUseFilePaths: [],
      },
    },
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

function seed(chatFlow: ChatFlow | null): void {
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
      appliedVersion: null,
      rawAppliedRecordUuids: new Set<string>(),
    });
    return { sessions, activeSessionId: SID };
  });
}

function userRec(o: Partial<RawRecord> = {}): RawRecord {
  return {
    type: "user",
    uuid: "uuid-1",
    parentUuid: null,
    promptId: "prompt-1",
    timestamp: "2026-05-12T00:00:00Z",
    message: { role: "user", content: "hello" },
    ...o,
  };
}

beforeEach(() => {
  useStore.setState({ sessions: new Map(), activeSessionId: null });
});

describe("applyRawRecord", () => {
  it("appends a placeholder ChatNode for a fresh user record", () => {
    seed(flow([cn("a")]));
    useStore.getState().applyRawRecord(SID, userRec({ promptId: "p2", uuid: "u2" }));
    const cf = useStore.getState().sessions.get(SID)?.chatFlow;
    expect(cf?.chatNodes.map((c) => c.id)).toEqual(["a", "p2"]);
    const placeholder = cf?.chatNodes.find((c) => c.id === "p2");
    expect(placeholder?.userMessage.uuid).toBe("u2");
    expect(placeholder?.userMessage.content).toBe("hello");
    expect(placeholder?.workflow.summary?.hasInFlightWork).toBe(true);
  });

  it("dedups when a ChatNode with the same promptId already exists", () => {
    seed(flow([cn("p1")]));
    useStore.getState().applyRawRecord(SID, userRec({ promptId: "p1", uuid: "u-new" }));
    const cf = useStore.getState().sessions.get(SID)?.chatFlow;
    expect(cf?.chatNodes).toHaveLength(1);
    // Original ChatNode untouched — no clobber from raw-record path.
    expect(cf?.chatNodes[0]?.userMessage.uuid).toBe("u-p1");
  });

  it("skips records without promptId", () => {
    seed(flow([cn("a")]));
    useStore.getState().applyRawRecord(SID, userRec({ promptId: undefined }));
    expect(useStore.getState().sessions.get(SID)?.chatFlow?.chatNodes).toHaveLength(1);
  });

  it("skips tool_result user records", () => {
    seed(flow([cn("a")]));
    useStore.getState().applyRawRecord(SID, {
      type: "user",
      uuid: "u",
      promptId: "p",
      toolUseResult: { stdout: "ok" },
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
    });
    expect(useStore.getState().sessions.get(SID)?.chatFlow?.chatNodes).toHaveLength(1);
  });

  it("skips meta / sidechain / compactSummary records", () => {
    seed(flow([cn("a")]));
    useStore.getState().applyRawRecord(SID, userRec({ promptId: "pmeta", isMeta: true }));
    useStore.getState().applyRawRecord(SID, userRec({ promptId: "pside", isSidechain: true }));
    useStore.getState().applyRawRecord(SID, userRec({ promptId: "pcomp", isCompactSummary: true }));
    expect(useStore.getState().sessions.get(SID)?.chatFlow?.chatNodes).toHaveLength(1);
  });

  it("skips assistant / system / etc. records", () => {
    seed(flow([cn("a")]));
    useStore.getState().applyRawRecord(SID, {
      type: "assistant",
      uuid: "u",
      promptId: "p",
      message: { role: "assistant", content: "hi" },
    });
    useStore.getState().applyRawRecord(SID, { type: "system", uuid: "u2", promptId: "p2" });
    expect(useStore.getState().sessions.get(SID)?.chatFlow?.chatNodes).toHaveLength(1);
  });

  it("no-op when session is missing or chatFlow is null", () => {
    // Missing session entry — should not throw.
    useStore.getState().applyRawRecord("missing-sid", userRec());
    seed(null);
    useStore.getState().applyRawRecord(SID, userRec());
    expect(useStore.getState().sessions.get(SID)?.chatFlow).toBeNull();
  });

  it("assistant record appends streaming text to host ChatNode", () => {
    seed(flow([cn("p1")]));
    useStore.getState().applyRawRecord(SID, {
      type: "assistant",
      uuid: "a-1",
      promptId: "p1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
        model: "claude-opus-4-7",
      },
    });
    const host = useStore.getState().sessions.get(SID)?.chatFlow?.chatNodes[0];
    expect(host?.workflow.summary?.assistantText).toEqual(["Hello world"]);
    expect(host?.workflow.summary?.assistantPreview).toBe("Hello world");
    expect(host?.workflow.summary?.llmCount).toBe(1);
    expect(host?.workflow.summary?.lastModel).toBe("claude-opus-4-7");
  });

  it("multiple assistant records on same promptId stack in assistantText", () => {
    seed(flow([cn("p1")]));
    useStore.getState().applyRawRecord(SID, {
      type: "assistant",
      uuid: "a-1",
      promptId: "p1",
      message: { role: "assistant", content: [{ type: "text", text: "round 1" }] },
    });
    useStore.getState().applyRawRecord(SID, {
      type: "assistant",
      uuid: "a-2",
      promptId: "p1",
      message: { role: "assistant", content: [{ type: "text", text: "round 2" }] },
    });
    const host = useStore.getState().sessions.get(SID)?.chatFlow?.chatNodes[0];
    expect(host?.workflow.summary?.assistantText).toEqual(["round 1", "round 2"]);
    expect(host?.workflow.summary?.assistantPreview).toBe("round 2");
    expect(host?.workflow.summary?.llmCount).toBe(2);
  });

  it("assistant record is idempotent — re-applying same uuid is a no-op", () => {
    seed(flow([cn("p1")]));
    const rec: RawRecord = {
      type: "assistant",
      uuid: "a-1",
      promptId: "p1",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    };
    useStore.getState().applyRawRecord(SID, rec);
    useStore.getState().applyRawRecord(SID, rec);
    const host = useStore.getState().sessions.get(SID)?.chatFlow?.chatNodes[0];
    expect(host?.workflow.summary?.assistantText).toEqual(["hi"]);
    expect(host?.workflow.summary?.llmCount).toBe(1);
  });

  it("assistant record with empty / whitespace-only text is skipped", () => {
    seed(flow([cn("p1")]));
    useStore.getState().applyRawRecord(SID, {
      type: "assistant",
      uuid: "a-1",
      promptId: "p1",
      message: { role: "assistant", content: [{ type: "text", text: "   " }] },
    });
    // Pure tool_use rounds also have no text — same skip.
    useStore.getState().applyRawRecord(SID, {
      type: "assistant",
      uuid: "a-2",
      promptId: "p1",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } },
        ],
      },
    });
    const host = useStore.getState().sessions.get(SID)?.chatFlow?.chatNodes[0];
    expect(host?.workflow.summary?.assistantText ?? []).toEqual([]);
    expect(host?.workflow.summary?.llmCount).toBe(0);
  });

  it("assistant record without a matching host ChatNode is dropped", () => {
    seed(flow([cn("p1")]));
    useStore.getState().applyRawRecord(SID, {
      type: "assistant",
      uuid: "a-1",
      promptId: "no-such-prompt",
      message: { role: "assistant", content: [{ type: "text", text: "lost" }] },
    });
    const cf = useStore.getState().sessions.get(SID)?.chatFlow;
    expect(cf?.chatNodes).toHaveLength(1);
    expect(cf?.chatNodes[0]?.workflow.summary?.assistantText ?? []).toEqual([]);
  });

  it("user record idempotency — re-applying same uuid does not duplicate", () => {
    seed(flow([cn("a")]));
    const rec: RawRecord = userRec({ promptId: "p2", uuid: "u2" });
    useStore.getState().applyRawRecord(SID, rec);
    useStore.getState().applyRawRecord(SID, rec);
    const cf = useStore.getState().sessions.get(SID)?.chatFlow;
    expect(cf?.chatNodes).toHaveLength(2); // a + p2 only
  });

  it("ground-truth delta replaces the placeholder via id match", () => {
    seed(flow([cn("a")]));
    useStore.getState().applyRawRecord(SID, userRec({ promptId: "p2", uuid: "u2" }));
    // Placeholder is now in place. Simulate the delayed chatnode-added
    // delta arriving with the real ChatNode under the same id.
    const real: ChatNode = {
      ...cn("p2"),
      userMessage: { uuid: "u2", content: "hello", attachments: [] },
      workflow: {
        nodes: [],
        edges: [],
        summary: {
          assistantPreview: "real assistant",
          assistantText: ["real assistant"],
          llmCount: 1,
          hasInFlightWork: false,
          chainCount: 1,
          toolCount: 0,
          totalThinkingChars: 0,
          contextTokens: 100,
          maxContextTokens: 200000,
          inputTokens: 50,
          outputTokens: 30,
          durationMs: 1234,
          toolUseFilePaths: [],
        },
      },
    };
    useStore.getState().applyChatFlowDelta(SID, {
      type: "chatnode-added",
      seq: 1,
      chatNode: real,
    });
    const cf = useStore.getState().sessions.get(SID)?.chatFlow;
    expect(cf?.chatNodes).toHaveLength(2);
    const replaced = cf?.chatNodes.find((c) => c.id === "p2");
    expect(replaced?.workflow.summary?.assistantPreview).toBe("real assistant");
    expect(replaced?.workflow.summary?.hasInFlightWork).toBe(false);
  });
});
