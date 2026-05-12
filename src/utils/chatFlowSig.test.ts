// EN (v2.1 PR D3): unit tests for the shared chatflow signature +
// hash helpers. Both server and client run the same algorithm, so
// these tests pin the contract — a change here that doesn't update
// both call sites would break drift detection.
//
// 中: 服务端 + 客户端共用的签名 + 哈希算法。改这里要两边同步动。

import { describe, expect, it } from "vitest";

import {
  chatFlowHash,
  chatNodeSig,
  hashFromSigs,
  summarySig,
} from "@/utils/chatFlowSig";
import type { ChatNode, WorkflowSummary } from "@/data/types";

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

function cn(id: string, parent: string | null = null, s: Partial<WorkflowSummary> = {}): ChatNode {
  return {
    kind: "chat",
    id,
    parentChatNodeId: parent,
    rootUserUuid: `u-${id}`,
    userMessage: { uuid: `u-${id}`, content: id, attachments: [] },
    workflow: { nodes: [], edges: [], summary: summary(s) },
    trigger: "user",
    isCompactSummary: false,
    meta: {},
  };
}

describe("summarySig", () => {
  it("returns 'no-summary' for undefined", () => {
    expect(summarySig(undefined)).toBe("no-summary");
  });

  it("equal summaries produce equal sigs", () => {
    expect(summarySig(summary({ llmCount: 3 }))).toBe(
      summarySig(summary({ llmCount: 3 })),
    );
  });

  it("different llmCount produces different sigs", () => {
    expect(summarySig(summary({ llmCount: 3 }))).not.toBe(
      summarySig(summary({ llmCount: 4 })),
    );
  });

  it("different lastModel produces different sigs", () => {
    expect(summarySig(summary({ lastModel: "claude-opus-4-7" }))).not.toBe(
      summarySig(summary({ lastModel: "claude-sonnet-4-6" })),
    );
  });
});

describe("chatFlowHash", () => {
  it("equal arrays produce equal hashes", () => {
    const a = chatFlowHash([cn("a"), cn("b", "a")]);
    const b = chatFlowHash([cn("a"), cn("b", "a")]);
    expect(a).toBe(b);
  });

  it("order independent — same nodes in different order = same hash", () => {
    const a = chatFlowHash([cn("a"), cn("b", "a")]);
    const b = chatFlowHash([cn("b", "a"), cn("a")]);
    expect(a).toBe(b);
  });

  it("different content = different hash", () => {
    const a = chatFlowHash([cn("a", null, { llmCount: 1 })]);
    const b = chatFlowHash([cn("a", null, { llmCount: 2 })]);
    expect(a).not.toBe(b);
  });

  it("empty array yields a stable hash", () => {
    expect(chatFlowHash([])).toBe(chatFlowHash([]));
  });

  it("hashFromSigs and chatFlowHash agree on the same content", () => {
    const nodes = [cn("a"), cn("b", "a")];
    expect(hashFromSigs(nodes.map(chatNodeSig))).toBe(chatFlowHash(nodes));
  });
});
