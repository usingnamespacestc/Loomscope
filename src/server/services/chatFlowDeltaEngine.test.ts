// EN (v2.1 PR D1): unit tests for the chatflow delta engine. Tests
// drive `processFresh` directly with synthetic ChatFlow objects and
// observe the SSE broadcasts to verify the diff produces the right
// sequence of semantic events.
//
// 中: delta 引擎单测。直接构造 ChatFlow 喂 processFresh，看 SSE
// 收到的事件序列对不对。

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetForTests as resetSseHub,
  subscribe,
  type SseMessage,
} from "@/server/services/sseHub";
import {
  _resetAllForTests,
  processFresh,
  resetSession,
  type ChatFlowDeltaEvent,
} from "@/server/services/chatFlowDeltaEngine";
import type {
  ChatFlow,
  ChatNode,
  WorkflowSummary,
} from "@/data/types";

const SID = "11111111-1111-4000-8000-000000000aaa";

function summary(overrides: Partial<WorkflowSummary> = {}): WorkflowSummary {
  return {
    assistantPreview: "",
    assistantText: [],
    llmCount: 1,
    hasInFlightWork: false,
    chainCount: 1,
    toolCount: 0,
    inputTokens: 100,
    outputTokens: 50,
    durationMs: 1000,
    lastModel: "claude-opus-4-7",
    contextTokens: 1000,
    maxContextTokens: 200000,
    totalThinkingChars: 0,
    toolUseFilePaths: [],
    ...overrides,
  };
}

function chatNode(
  id: string,
  parent: string | null = null,
  s: Partial<WorkflowSummary> = {},
): ChatNode {
  return {
    kind: "chat",
    id,
    parentChatNodeId: parent,
    rootUserUuid: `u-${id}`,
    userMessage: { uuid: `u-${id}`, content: `prompt ${id}`, attachments: [] },
    workflow: { nodes: [], edges: [], summary: summary(s) },
    trigger: "user",
    isCompactSummary: false,
    meta: {},
  };
}

function chatFlow(nodes: ChatNode[]): ChatFlow {
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

function captureSse(sessionId: string): SseMessage[] {
  const captured: SseMessage[] = [];
  subscribe(sessionId, { send: (msg) => captured.push(msg) });
  return captured;
}

function deltasOf(msgs: SseMessage[]): ChatFlowDeltaEvent[] {
  return msgs
    .filter((m) => m.event === "delta")
    .map((m) => m.data as ChatFlowDeltaEvent);
}

beforeEach(() => {
  resetSseHub();
  _resetAllForTests();
});

afterEach(() => {
  _resetAllForTests();
});

describe("chatFlowDeltaEngine — processFresh", () => {
  it("first call emits chatnode-added for every node + checkpoint", async () => {
    const captured = captureSse(SID);
    const cf = chatFlow([chatNode("a"), chatNode("b", "a")]);
    const deltas = await processFresh(SID, cf);
    expect(deltas.length).toBe(3); // 2 added + 1 checkpoint
    expect(deltas[0].type).toBe("chatnode-added");
    expect((deltas[0] as Extract<ChatFlowDeltaEvent, { type: "chatnode-added" }>).chatNode.id).toBe("a");
    expect(deltas[1].type).toBe("chatnode-added");
    expect(deltas[2].type).toBe("checkpoint");
    // seq is monotonic.
    // 中: seq 单调递增。
    expect(deltas[0].seq).toBe(1);
    expect(deltas[1].seq).toBe(2);
    expect(deltas[2].seq).toBe(3);
    // SSE broadcasted.
    expect(deltasOf(captured)).toEqual(deltas);
  });

  it("second call with no changes emits ONLY checkpoint", async () => {
    const cf = chatFlow([chatNode("a"), chatNode("b", "a")]);
    await processFresh(SID, cf);
    const captured = captureSse(SID);
    const deltas = await processFresh(SID, cf);
    // No structural / summary change → only the checkpoint.
    // 中: 没有变化时只 emit checkpoint。
    expect(deltas.length).toBe(1);
    expect(deltas[0].type).toBe("checkpoint");
    expect(deltasOf(captured)).toEqual(deltas);
  });

  it("adding a new ChatNode emits chatnode-added + checkpoint", async () => {
    await processFresh(SID, chatFlow([chatNode("a")]));
    const captured = captureSse(SID);
    const deltas = await processFresh(SID, chatFlow([chatNode("a"), chatNode("b", "a")]));
    expect(deltas.length).toBe(2);
    expect(deltas[0].type).toBe("chatnode-added");
    expect(
      (deltas[0] as Extract<ChatFlowDeltaEvent, { type: "chatnode-added" }>).chatNode.id,
    ).toBe("b");
    expect(deltas[1].type).toBe("checkpoint");
    expect(deltasOf(captured)).toEqual(deltas);
  });

  it("changing a node's summary emits chatnode-summary-updated", async () => {
    await processFresh(SID, chatFlow([chatNode("a", null, { llmCount: 1 })]));
    const captured = captureSse(SID);
    const deltas = await processFresh(
      SID,
      chatFlow([chatNode("a", null, { llmCount: 2 })]),
    );
    expect(deltas.length).toBe(2);
    expect(deltas[0].type).toBe("chatnode-summary-updated");
    const u = deltas[0] as Extract<
      ChatFlowDeltaEvent,
      { type: "chatnode-summary-updated" }
    >;
    expect(u.chatNodeId).toBe("a");
    expect(u.summary.llmCount).toBe(2);
    expect(deltas[1].type).toBe("checkpoint");
    expect(deltasOf(captured)).toEqual(deltas);
  });

  it("removing a node emits chatnode-removed", async () => {
    await processFresh(SID, chatFlow([chatNode("a"), chatNode("b", "a")]));
    const captured = captureSse(SID);
    const deltas = await processFresh(SID, chatFlow([chatNode("a")]));
    expect(deltas.length).toBe(2);
    expect(deltas[0].type).toBe("chatnode-removed");
    expect(
      (deltas[0] as Extract<ChatFlowDeltaEvent, { type: "chatnode-removed" }>).chatNodeId,
    ).toBe("b");
    expect(deltas[1].type).toBe("checkpoint");
    expect(deltasOf(captured)).toEqual(deltas);
  });

  it("checkpoint carries the live chatNodeCount", async () => {
    const deltas = await processFresh(
      SID,
      chatFlow([chatNode("a"), chatNode("b", "a"), chatNode("c", "b")]),
    );
    const cp = deltas[deltas.length - 1] as Extract<
      ChatFlowDeltaEvent,
      { type: "checkpoint" }
    >;
    expect(cp.chatNodeCount).toBe(3);
  });

  it("seq continues across calls; doesn't reset between processFresh batches", async () => {
    const d1 = await processFresh(SID, chatFlow([chatNode("a")]));
    const d2 = await processFresh(SID, chatFlow([chatNode("a"), chatNode("b", "a")]));
    const lastSeqD1 = d1[d1.length - 1].seq;
    const firstSeqD2 = d2[0].seq;
    expect(firstSeqD2).toBe(lastSeqD1 + 1);
  });

  it("resetSession clears state — next processFresh re-emits ALL nodes as added", async () => {
    await processFresh(SID, chatFlow([chatNode("a"), chatNode("b", "a")]));
    resetSession(SID);
    const captured = captureSse(SID);
    const deltas = await processFresh(
      SID,
      chatFlow([chatNode("a"), chatNode("b", "a")]),
    );
    expect(deltas.filter((d) => d.type === "chatnode-added").length).toBe(2);
    // seq starts back at 1 after reset.
    // 中: reset 后 seq 从 1 重起。
    expect(deltas[0].seq).toBe(1);
    expect(deltasOf(captured)).toEqual(deltas);
  });

  it("per-session serialisation: simultaneous processFresh calls don't interleave deltas", async () => {
    // Fire two processFresh calls concurrently; the second's deltas
    // must arrive AFTER the first's complete (per-session promise
    // chain).
    // 中: 同 session 的两次 processFresh 并发调用，第二批必须排在
    // 第一批所有 delta 之后（per-session 串行）。
    const p1 = processFresh(SID, chatFlow([chatNode("a")]));
    const p2 = processFresh(SID, chatFlow([chatNode("a"), chatNode("b", "a")]));
    const [d1, d2] = await Promise.all([p1, p2]);
    // seq is shared across both calls; d2's first seq is d1's last + 1.
    // 中: 两批共用 seq。
    expect(d2[0].seq).toBe(d1[d1.length - 1].seq + 1);
  });

  it("different sessions get independent snapshots", async () => {
    const SID2 = "22222222-2222-4000-8000-000000000bbb";
    await processFresh(SID, chatFlow([chatNode("a")]));
    const captured2 = captureSse(SID2);
    const deltas2 = await processFresh(
      SID2,
      chatFlow([{ ...chatNode("a"), id: SID2 + "-cn" }]),
    );
    expect(deltas2[0].type).toBe("chatnode-added"); // SID2 sees fresh
    expect(deltas2[0].seq).toBe(1);
    expect(deltasOf(captured2).length).toBe(deltas2.length);
  });
});
