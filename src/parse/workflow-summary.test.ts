import { describe, expect, it } from "vitest";

import { computeWorkflowSummary } from "@/parse/workflow-summary";
import type { WorkNode } from "@/data/types";

function llmCall(id: string, text: string, parentUuid: string | null = null): WorkNode {
  return {
    id,
    kind: "llm_call",
    parentUuid,
    text,
    thinking: [],
    model: "claude-3-5-sonnet",
    stopReason: "end_turn",
  } as unknown as WorkNode;
}

function toolCall(id: string, parentUuid: string | null = null): WorkNode {
  return {
    id,
    kind: "tool_call",
    parentUuid,
    toolName: "Bash",
    input: {},
    resultBlock: { type: "tool_result", content: "ok" },
  } as unknown as WorkNode;
}

function compactNode(id: string, parentUuid: string | null = null): WorkNode {
  return {
    id,
    kind: "compact",
    parentUuid,
    summaryText: "compressed history of pre-compact rounds",
  } as unknown as WorkNode;
}

describe("computeWorkflowSummary — innerCompactLlmCallBoundaryIdx", () => {
  it("undefined when no compact WorkNode in workflow", () => {
    const nodes = [llmCall("a", "hi"), toolCall("t1"), llmCall("b", "bye")];
    const s = computeWorkflowSummary(nodes, []);
    expect(s.innerCompactLlmCallBoundaryIdx).toBeUndefined();
    expect(s.assistantText).toEqual(["hi", "bye"]);
  });

  it("0 when compact fires before any llm_call (rare)", () => {
    const nodes = [compactNode("c1"), llmCall("a", "post-compact")];
    const s = computeWorkflowSummary(nodes, []);
    expect(s.innerCompactLlmCallBoundaryIdx).toBe(0);
    expect(s.assistantText.slice(0, 0)).toEqual([]);
    expect(s.assistantText.slice(0)).toEqual(["post-compact"]);
  });

  it("counts text-carrying llm_calls before the compact node", () => {
    const nodes = [
      llmCall("a", "pre-1"),
      toolCall("t1"),
      llmCall("b", "pre-2"),
      toolCall("t2"),
      compactNode("c1"),
      llmCall("c", "post-1"),
      llmCall("d", "post-2"),
    ];
    const s = computeWorkflowSummary(nodes, []);
    expect(s.innerCompactLlmCallBoundaryIdx).toBe(2);
    expect(s.assistantText).toEqual(["pre-1", "pre-2", "post-1", "post-2"]);
    expect(s.assistantText.slice(0, 2)).toEqual(["pre-1", "pre-2"]);
    expect(s.assistantText.slice(2)).toEqual(["post-1", "post-2"]);
  });

  it("skips llm_calls with empty text when counting (matches assistantText filter)", () => {
    const nodes = [
      llmCall("a", "pre-1"),
      llmCall("b", ""), // empty — skipped from assistantText AND boundary count
      llmCall("c", "pre-2"),
      compactNode("c1"),
      llmCall("d", "post-1"),
    ];
    const s = computeWorkflowSummary(nodes, []);
    expect(s.innerCompactLlmCallBoundaryIdx).toBe(2);
    expect(s.assistantText).toEqual(["pre-1", "pre-2", "post-1"]);
  });

  it("skips synthetic llm_calls when counting (matches isRealLlmCall filter)", () => {
    const synthetic: WorkNode = {
      id: "syn",
      kind: "llm_call",
      parentUuid: null,
      text: "rate-limit-fake",
      thinking: [],
      model: "<synthetic>",
    } as unknown as WorkNode;
    const nodes = [
      llmCall("a", "pre-1"),
      synthetic, // model "<synthetic>" — excluded from assistantText AND count
      compactNode("c1"),
      llmCall("c", "post-1"),
    ];
    const s = computeWorkflowSummary(nodes, []);
    expect(s.innerCompactLlmCallBoundaryIdx).toBe(1);
  });

  it("uses the FIRST compact when workflow contains multiple (defensive)", () => {
    const nodes = [
      llmCall("a", "pre-1"),
      compactNode("c1"),
      llmCall("b", "mid"),
      compactNode("c2"),
      llmCall("c", "post"),
    ];
    const s = computeWorkflowSummary(nodes, []);
    // First compact at idx 1, with 1 text-carrying llm_call before.
    expect(s.innerCompactLlmCallBoundaryIdx).toBe(1);
  });
});

describe("computeWorkflowSummary — v1.5 inputTokens / outputTokens / durationMs", () => {
  function llmCallWithUsage(
    id: string,
    usage: Record<string, number>,
    timestamp?: string,
  ): WorkNode {
    return {
      id,
      kind: "llm_call",
      parentUuid: null,
      text: "x",
      thinking: [],
      model: "claude-3-5-sonnet",
      stopReason: "end_turn",
      usage,
      timestamp,
    } as unknown as WorkNode;
  }

  it("sums input + cache_creation across all real llm_calls (excludes cache_read replay)", () => {
    const nodes = [
      llmCallWithUsage("a", {
        input_tokens: 100,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 9_999, // excluded
        output_tokens: 30,
      }),
      llmCallWithUsage("b", {
        input_tokens: 200,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 1_000, // excluded
        output_tokens: 70,
      }),
    ];
    const s = computeWorkflowSummary(nodes, []);
    // input = (100+50) + (200+0) = 350
    expect(s.inputTokens).toBe(350);
    // output = 30 + 70
    expect(s.outputTokens).toBe(100);
  });

  it("durationMs = last node's timestamp − first node's timestamp", () => {
    const nodes = [
      llmCallWithUsage("a", { input_tokens: 1 }, "2026-05-10T10:00:00.000Z"),
      llmCallWithUsage(
        "b",
        { input_tokens: 1 },
        "2026-05-10T10:01:23.000Z",
      ),
    ];
    const s = computeWorkflowSummary(nodes, []);
    expect(s.durationMs).toBe(83_000); // 1m 23s
  });

  it("durationMs is null when first or last timestamp missing", () => {
    const nodes = [
      llmCallWithUsage("a", { input_tokens: 1 }), // no timestamp
      llmCallWithUsage("b", { input_tokens: 1 }, "2026-05-10T10:00:00.000Z"),
    ];
    const s = computeWorkflowSummary(nodes, []);
    expect(s.durationMs).toBeNull();
  });

  it("durationMs is null when nodes is empty", () => {
    const s = computeWorkflowSummary([], []);
    expect(s.durationMs).toBeNull();
    expect(s.inputTokens).toBe(0);
    expect(s.outputTokens).toBe(0);
  });

  it("skips synthetic llm_calls when summing tokens (matches isRealLlmCall filter)", () => {
    const synthetic: WorkNode = {
      id: "syn",
      kind: "llm_call",
      parentUuid: null,
      text: "fake",
      thinking: [],
      model: "<synthetic>",
      stopReason: "rate_limit",
      usage: { input_tokens: 99_999, output_tokens: 99_999 },
    } as unknown as WorkNode;
    const nodes = [
      synthetic,
      llmCallWithUsage("real", {
        input_tokens: 100,
        output_tokens: 50,
      }),
    ];
    const s = computeWorkflowSummary(nodes, []);
    expect(s.inputTokens).toBe(100);
    expect(s.outputTokens).toBe(50);
  });
});
