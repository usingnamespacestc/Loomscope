import { describe, expect, it } from "vitest";

import {
  layoutChatFlow,
  lastAssistantPreview,
  maxContextForModel,
  previewUserContent,
} from "@/canvas/layoutDag";
import type { ChatFlow, ChatNode } from "@/data/types";

function makeChatNode(overrides: Partial<ChatNode>): ChatNode {
  const id = overrides.id ?? "p-1";
  return {
    id,
    parentChatNodeId: null,
    rootUserUuid: `${id}-u`,
    userMessage: { uuid: `${id}-u`, content: "", attachments: [] },
    workflow: { nodes: [], edges: [] },
    trigger: "user",
    isCompactSummary: false,
    meta: {},
    ...overrides,
  };
}

function makeChatFlow(chatNodes: ChatNode[]): ChatFlow {
  return {
    id: "session-x",
    mainJsonlPath: "/tmp/x.jsonl",
    sidecarDir: "/tmp/x",
    chatNodes,
    orphans: [],
    flowEvents: [],
    trigger: "user",
  };
}

describe("layoutChatFlow", () => {
  it("emits one RF node per ChatNode", () => {
    const cf = makeChatFlow([
      makeChatNode({ id: "p1" }),
      makeChatNode({ id: "p2", parentChatNodeId: "p1" }),
      makeChatNode({ id: "p3", parentChatNodeId: "p2" }),
    ]);
    const { nodes, edges } = layoutChatFlow(cf);
    expect(nodes.map((n) => n.id).sort()).toEqual(["p1", "p2", "p3"]);
    expect(edges.length).toBe(2);
  });

  it("emits continuation edges from parentChatNodeId", () => {
    const cf = makeChatFlow([
      makeChatNode({ id: "p1" }),
      makeChatNode({ id: "p2", parentChatNodeId: "p1" }),
    ]);
    const { edges } = layoutChatFlow(cf);
    expect(edges[0].source).toBe("p1");
    expect(edges[0].target).toBe("p2");
    expect(edges[0].type).toBe("continuation");
  });

  it("lays out left→right (LR): parent x < child x", () => {
    const cf = makeChatFlow([
      makeChatNode({ id: "p1" }),
      makeChatNode({ id: "p2", parentChatNodeId: "p1" }),
    ]);
    const { nodes } = layoutChatFlow(cf);
    const a = nodes.find((n) => n.id === "p1")!;
    const b = nodes.find((n) => n.id === "p2")!;
    expect(a.position.x).toBeLessThan(b.position.x);
  });

  it("preserves chatNode reference inside data so card can reach into workflow", () => {
    const cn = makeChatNode({ id: "p1" });
    const cf = makeChatFlow([cn]);
    const { nodes } = layoutChatFlow(cf);
    expect(nodes[0].data.chatNode).toBe(cn);
  });

  it("looks up context window per-ChatNode based on each turn's model — mid-session switch is honored", () => {
    const cf = makeChatFlow([
      makeChatNode({
        id: "p1",
        workflow: {
          nodes: [
            {
              id: "l1",
              kind: "llm_call",
              parentUuid: null,
              text: "",
              thinking: [],
              model: "claude-opus-4-7",
              usage: { input_tokens: 100, cache_read_input_tokens: 50_000 },
            },
          ],
          edges: [],
        },
      }),
      makeChatNode({
        id: "p2",
        parentChatNodeId: "p1",
        workflow: {
          nodes: [
            {
              id: "l2",
              kind: "llm_call",
              parentUuid: null,
              text: "",
              thinking: [],
              model: "claude-sonnet-4-6", // switched
              usage: { input_tokens: 100, cache_read_input_tokens: 30_000 },
            },
          ],
          edges: [],
        },
      }),
    ]);
    const { nodes } = layoutChatFlow(cf);
    const a = nodes.find((n) => n.id === "p1")!;
    const b = nodes.find((n) => n.id === "p2")!;
    // p1 → Opus → 1M cap regardless of token count
    expect(a.data.maxContextTokens).toBe(1_000_000);
    expect(a.data.contextTokens).toBe(50_100);
    // p2 → Sonnet → 200k cap (mid-session switch reflected)
    expect(b.data.maxContextTokens).toBe(200_000);
    expect(b.data.contextTokens).toBe(30_100);
  });

  it("uses *last* llm_call's model within a single ChatNode (final context state)", () => {
    // Within one turn the model could in principle change mid-loop;
    // we surface the model at end-of-turn (last llm_call) since
    // that's the snapshot a viewer cares about: "where did we end up?"
    const cf = makeChatFlow([
      makeChatNode({
        id: "p1",
        workflow: {
          nodes: [
            {
              id: "l-early",
              kind: "llm_call",
              parentUuid: null,
              text: "",
              thinking: [],
              model: "claude-sonnet-4-6",
              usage: { input_tokens: 5, cache_read_input_tokens: 100 },
            },
            {
              id: "l-late",
              kind: "llm_call",
              parentUuid: "l-early",
              text: "",
              thinking: [],
              model: "claude-opus-4-7",
              usage: { input_tokens: 200, cache_read_input_tokens: 80_000 },
            },
          ],
          edges: [],
        },
      }),
    ]);
    const { nodes } = layoutChatFlow(cf);
    expect(nodes[0].data.maxContextTokens).toBe(1_000_000);
    expect(nodes[0].data.contextTokens).toBe(80_200);
  });

  it("counts tool/llm nodes in workflow", () => {
    const cf = makeChatFlow([
      makeChatNode({
        id: "p1",
        workflow: {
          nodes: [
            {
              id: "l1",
              kind: "llm_call",
              parentUuid: null,
              text: "Hello",
              thinking: [],
            },
            {
              id: "t1",
              kind: "tool_call",
              parentUuid: null,
              toolName: "Bash",
              input: {},
            },
            {
              id: "d1",
              kind: "delegate",
              parentUuid: null,
              toolName: "Agent",
            },
          ],
          edges: [],
        },
      }),
    ]);
    const { nodes } = layoutChatFlow(cf);
    expect(nodes[0].data.llmCount).toBe(1);
    expect(nodes[0].data.toolCount).toBe(2); // tool_call + delegate
  });
});

describe("maxContextForModel", () => {
  it("opus → 1M (default 1M context per CC /model picker)", () => {
    expect(maxContextForModel("claude-opus-4-7")).toBe(1_000_000);
    expect(maxContextForModel("claude-opus-4-6")).toBe(1_000_000);
  });
  it("sonnet → 200k (1M beta is rare, default 200k)", () => {
    expect(maxContextForModel("claude-sonnet-4-6")).toBe(200_000);
    expect(maxContextForModel("claude-sonnet-4-5")).toBe(200_000);
  });
  it("haiku → 200k", () => {
    expect(maxContextForModel("claude-haiku-4-5")).toBe(200_000);
  });
  it("unknown / undefined → 200k safe default", () => {
    expect(maxContextForModel(undefined)).toBe(200_000);
    expect(maxContextForModel("")).toBe(200_000);
    expect(maxContextForModel("gpt-4o")).toBe(200_000);
    expect(maxContextForModel("future-claude-x")).toBe(200_000);
  });
  it("ignores [1m] suffix presence — table is keyed on model family, not suffix", () => {
    // CC strips [1m] from jsonl; even if it leaks through somehow, family
    // match dominates.
    expect(maxContextForModel("claude-opus-4-7[1m]")).toBe(1_000_000);
    expect(maxContextForModel("claude-sonnet-4-6[1m]")).toBe(200_000);
  });
});

describe("previewUserContent", () => {
  it("returns truncated string content", () => {
    const long = "a".repeat(200);
    const out = previewUserContent(long);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith("…")).toBe(true);
  });

  it("collapses whitespace", () => {
    expect(previewUserContent("  hello   world  ")).toBe("hello world");
  });

  it("extracts text from block array", () => {
    expect(previewUserContent([{ type: "text", text: "block content" }])).toBe(
      "block content",
    );
  });

  it("returns empty string for unsupported shapes", () => {
    expect(previewUserContent(null)).toBe("");
    expect(previewUserContent({ foo: "bar" })).toBe("");
  });
});

describe("lastAssistantPreview", () => {
  it("returns the last non-empty llm_call text", () => {
    const cn = makeChatNode({
      id: "p1",
      workflow: {
        nodes: [
          { id: "l1", kind: "llm_call", parentUuid: null, text: "early thought", thinking: [] },
          { id: "l2", kind: "llm_call", parentUuid: null, text: "", thinking: [] },
          { id: "l3", kind: "llm_call", parentUuid: null, text: "final answer", thinking: [] },
        ],
        edges: [],
      },
    });
    expect(lastAssistantPreview(cn)).toBe("final answer");
  });

  it("returns empty string when no llm_call has text", () => {
    const cn = makeChatNode({ id: "p1" });
    expect(lastAssistantPreview(cn)).toBe("");
  });
});
