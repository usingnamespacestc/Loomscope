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

import { chatFlowLayoutSignature } from "@/canvas/layoutDag";
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
