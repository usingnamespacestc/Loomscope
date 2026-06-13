// EN (2026-05-16 perf): proves chatFlowLayoutSignature is byte-stable
// across the streaming case that caused long-conversation jank.
//
// The dominant long-conv jank source: while a long assistant reply
// streams in, CC emits a burst of `chatnode-summary-updated` deltas
// for the SAME ChatNode (assistant text growing). Each one mints a
// fresh chatFlow object; ChatFlowCanvas previously memoised the dagre
// layout on the chatFlow object ref, so every such delta re-ran a
// full N-node dagre layout (hundreds of ms each on a 600-node
// session → multi-second main-thread jank).
//
// The fix memoises layout on chatFlowLayoutSignature instead. This
// test asserts: applying a real `chatnode-summary-updated` delta
// through the actual store reducer leaves the signature byte-
// identical → the layout memo is a no-op for streaming deltas.
// Also asserts topology changes (chatnode-added) DO change it.

import { beforeEach, describe, expect, it } from "vitest";

import {
  chatFlowLayoutSignature,
  layoutChatFlow,
  refreshChatNodeContent,
} from "@/canvas/layoutDag";
import { chatFlowContentSignature } from "@/utils/chatFlowSig";
import { useStore } from "@/store/index";
import type { ChatFlow, ChatNode } from "@/data/types";

const SID = "siglong-0000-4000-8000-000000000001";

function node(id: string, parent: string | null): ChatNode {
  return {
    kind: "chat",
    id,
    parentChatNodeId: parent,
    rootUserUuid: `${id}-u`,
    userMessage: { uuid: `${id}-u`, content: "q", attachments: [] },
    workflow: {
      nodes: [],
      edges: [],
      summary: {
        assistantPreview: "",
        assistantText: [],
        hasInFlightWork: false,
        llmCount: 0,
        chainCount: 0,
        toolCount: 0,
        totalThinkingChars: 0,
        contextTokens: 0,
        maxContextTokens: 200000,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: null,
        toolUseFilePaths: [],
      },
    },
    trigger: "user",
    isCompactSummary: false,
    meta: {},
  } as ChatNode;
}

function bigChatFlow(n: number): ChatFlow {
  const chatNodes: ChatNode[] = [];
  for (let i = 0; i < n; i++) {
    chatNodes.push(node(`cn${i}`, i === 0 ? null : `cn${i - 1}`));
  }
  return {
    id: SID,
    mainJsonlPath: "/tmp/x.jsonl",
    sidecarDir: "/tmp/x",
    chatNodes,
    orphans: [],
    flowEvents: [],
    trigger: "user",
  } as ChatFlow;
}

beforeEach(() => {
  const cf = bigChatFlow(600);
  useStore.setState((s) => {
    const sessions = new Map(s.sessions);
    sessions.set(SID, {
      chatFlow: cf,
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
      appliedVersion: 5,
      serverVersion: null,
      rawAppliedRecordUuids: new Set<string>(),
    });
    return { sessions, activeSessionId: SID };
  });
});

describe("chatFlowLayoutSignature stability across store deltas", () => {
  it("byte-stable across a real chatnode-summary-updated delta (600 nodes)", () => {
    const before = chatFlowLayoutSignature(
      useStore.getState().sessions.get(SID)!.chatFlow!,
    );
    // Apply a real summary-updated delta through the store reducer —
    // exactly what an assistant reply streaming in produces.
    useStore.getState().applyChatFlowDelta(SID, {
      type: "chatnode-summary-updated",
      seq: 6,
      chatNodeId: "cn300",
      summary: {
        assistantPreview: "now there is a long streamed reply...",
        assistantText: ["a".repeat(5000)],
        hasInFlightWork: true,
        llmCount: 4,
        chainCount: 2,
        toolCount: 7,
        totalThinkingChars: 999,
        contextTokens: 54321,
        maxContextTokens: 200000,
        inputTokens: 11,
        outputTokens: 22,
        durationMs: 1234,
        toolUseFilePaths: ["/x/y.ts"],
      },
    });
    const cfAfter = useStore.getState().sessions.get(SID)!.chatFlow!;
    // Sanity: the delta actually landed (content changed).
    const cn = cfAfter.chatNodes.find((c) => c.id === "cn300")!;
    expect(cn.workflow.summary?.llmCount).toBe(4);
    // The layout signature must be byte-identical → layout memo is a
    // no-op for this delta (the whole point of the perf fix).
    const after = chatFlowLayoutSignature(cfAfter);
    expect(after).toBe(before);
  });

  it("DOES change across a chatnode-added delta (topology)", () => {
    const before = chatFlowLayoutSignature(
      useStore.getState().sessions.get(SID)!.chatFlow!,
    );
    useStore.getState().applyChatFlowDelta(SID, {
      type: "chatnode-added",
      seq: 6,
      chatNode: node("cn600", "cn599"),
    });
    const after = chatFlowLayoutSignature(
      useStore.getState().sessions.get(SID)!.chatFlow!,
    );
    expect(after).not.toBe(before);
  });
});

// EN (bug: "ChatNode assistant message doesn't update until the next
// message creates a node"). The layout-signature memo above is the
// CORRECT perf behaviour (no dagre on streaming deltas), but the
// canvas previously memoised BOTH positions AND card `data` on the
// layout signature alone — so a content-only summary delta updated
// the store yet the card stayed stale until the next topology change.
// `refreshChatNodeContent` is the content-side dual: it re-derives
// card `data` from the live chatFlow over the CACHED positions,
// O(N), with NO dagre. These tests pin both halves of the invariant.
// 中: 卡片直到下一条消息才更新——根因是 canvas 把位置和 data 一起按
// layout 指纹 memo。refreshChatNodeContent 是内容侧对偶：复用缓存
// 坐标只重算 data，无 dagre。下面钉死两半不变量。
describe("refreshChatNodeContent — content reaches the card w/o relayout", () => {
  function smallFlow(): ChatFlow {
    const chatNodes: ChatNode[] = [];
    for (let i = 0; i < 5; i++) {
      chatNodes.push(node(`cn${i}`, i === 0 ? null : `cn${i - 1}`));
    }
    return {
      id: SID,
      mainJsonlPath: "/tmp/x.jsonl",
      sidecarDir: "/tmp/x",
      chatNodes,
      orphans: [],
      flowEvents: [],
      trigger: "user",
    } as ChatFlow;
  }
  // Same topology, only cn2's assistant content streamed in (exactly
  // a `chatnode-summary-updated`).
  function withStreamedReply(cf: ChatFlow, id: string, text: string): ChatFlow {
    return {
      ...cf,
      chatNodes: cf.chatNodes.map((c) =>
        c.id === id
          ? {
              ...c,
              workflow: {
                ...c.workflow,
                summary: {
                  ...c.workflow.summary!,
                  assistantPreview: text,
                  assistantText: [text],
                  llmCount: 1,
                },
              },
            }
          : c,
      ),
    } as ChatFlow;
  }
  const calls = (): number =>
    (globalThis as unknown as { __layoutChatFlowCalls?: number })
      .__layoutChatFlowCalls ?? 0;

  it("re-derives card data on a content-only change WITHOUT a dagre relayout, reusing positions", () => {
    const cf0 = smallFlow();
    const laid = layoutChatFlow(cf0); // one real dagre pass
    const card0 = laid.nodes.find((n) => n.id === "cn2")!;
    expect(card0.type).toBe("chatNode");
    // Precondition (the bug state): card shows the stale empty preview.
    expect((card0.data as { assistantPreview: string }).assistantPreview).toBe(
      "",
    );

    const cf1 = withStreamedReply(cf0, "cn2", "STREAMED reply text 42");
    // The #226 invariant: structure-only signature is byte-stable, so
    // ChatFlowCanvas's position memo (gated on it) will NOT recompute
    // — which is exactly why the card used to stay stale.
    expect(chatFlowLayoutSignature(cf1)).toBe(chatFlowLayoutSignature(cf0));
    // The new content dual DOES fire.
    expect(chatFlowContentSignature(cf1)).not.toBe(
      chatFlowContentSignature(cf0),
    );

    const callsBefore = calls();
    const refreshed = refreshChatNodeContent(laid.nodes, cf1);
    // No dagre relayout happened (the deterministic, machine-noise-
    // immune #226 guard — refreshChatNodeContent must never call
    // layoutChatFlow).
    expect(calls()).toBe(callsBefore);

    const card1 = refreshed.find((n) => n.id === "cn2")!;
    // BUG FIXED: streamed assistant text now reaches the card with no
    // topology change.
    expect((card1.data as { assistantPreview: string }).assistantPreview).toBe(
      "STREAMED reply text 42",
    );
    // Position reused from the cached layout (no movement).
    expect(card1.position).toEqual(card0.position);
    // Untouched nodes keep their data object identity (no churn).
    const other0 = laid.nodes.find((n) => n.id === "cn4")!;
    const other1 = refreshed.find((n) => n.id === "cn4")!;
    expect(other1.position).toEqual(other0.position);
  });

  it("preserves node + data identity for unchanged nodes; re-mints only the changed one (memo-friendly)", () => {
    const cf0 = smallFlow();
    const laid = layoutChatFlow(cf0);
    const cf1 = withStreamedReply(cf0, "cn2", "only cn2 changed");
    const refreshed = refreshChatNodeContent(laid.nodes, cf1);

    // The one node whose content changed gets a fresh node + fresh data.
    const changed0 = laid.nodes.find((n) => n.id === "cn2")!;
    const changed1 = refreshed.find((n) => n.id === "cn2")!;
    expect(changed1).not.toBe(changed0);
    expect(changed1.data).not.toBe(changed0.data);

    // Every untouched node keeps BOTH its node and its data object
    // identity, so React.memo-wrapped cards short-circuit re-render.
    // (Before the fix this churned all N nodes on every content delta.)
    for (const id of ["cn0", "cn1", "cn3", "cn4"]) {
      const before = laid.nodes.find((n) => n.id === id)!;
      const after = refreshed.find((n) => n.id === id)!;
      expect(after).toBe(before);
      expect(after.data).toBe(before.data);
    }
  });

  it("returns the same array reference when there are no chat nodes (no spurious churn)", () => {
    const empty = {
      id: SID,
      mainJsonlPath: "/tmp/x.jsonl",
      sidecarDir: "/tmp/x",
      chatNodes: [],
      orphans: [],
      flowEvents: [],
      trigger: "user",
    } as ChatFlow;
    const laid = layoutChatFlow(empty);
    expect(refreshChatNodeContent(laid.nodes, empty)).toBe(laid.nodes);
  });
});
