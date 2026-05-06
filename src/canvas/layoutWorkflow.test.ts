import { describe, expect, it } from "vitest";

import {
  attachmentLabel,
  compactSummaryPreview,
  delegateContentPreview,
  layoutWorkFlow,
  llmCallThinkingLines,
  previewLlmCallText,
  previewToolInput,
  previewToolResult,
  WF_NODE_SIZE,
} from "@/canvas/layoutWorkflow";
import type {
  AttachmentNode,
  ChatNode,
  CompactNode,
  DelegateNode,
  LlmCallNode,
  ToolCallNode,
} from "@/data/types";

function makeChatNode(workflow: ChatNode["workflow"]): ChatNode {
  return {
    kind: "chat",
    id: "p1",
    parentChatNodeId: null,
    rootUserUuid: "u1",
    userMessage: { uuid: "u1", content: "", attachments: [] },
    workflow,
    trigger: "user",
    isCompactSummary: false,
    meta: {},
  };
}

const llm = (over: Partial<LlmCallNode> = {}): LlmCallNode => ({
  id: "l1",
  kind: "llm_call",
  parentUuid: null,
  text: "",
  thinking: [],
  ...over,
});

const tool = (over: Partial<ToolCallNode> = {}): ToolCallNode => ({
  id: "t1",
  kind: "tool_call",
  parentUuid: "l1",
  toolName: "Bash",
  input: {},
  ...over,
});

const delegate = (over: Partial<DelegateNode> = {}): DelegateNode => ({
  id: "d1",
  kind: "delegate",
  parentUuid: "l1",
  toolName: "Agent",
  ...over,
});

const compact = (over: Partial<CompactNode> = {}): CompactNode => ({
  id: "c1",
  kind: "compact",
  parentUuid: null,
  summaryText: "",
  ...over,
});

const attach = (over: Partial<AttachmentNode> = {}): AttachmentNode => ({
  id: "att1",
  kind: "attachment",
  parentUuid: null,
  attachmentType: "file",
  raw: {},
  ...over,
});

describe("layoutWorkFlow — graph construction", () => {
  it("emits one RF node per WorkNode regardless of kind", () => {
    const cn = makeChatNode({
      nodes: [
        llm({ id: "l1" }),
        tool({ id: "t1", parentUuid: "l1" }),
        delegate({ id: "d1", parentUuid: "l1" }),
        compact({ id: "c1" }),
        attach({ id: "a1" }),
      ],
      edges: [],
    });
    const { nodes } = layoutWorkFlow(cn);
    expect(nodes.map((n) => n.id).sort()).toEqual(["a1", "c1", "d1", "l1", "t1"]);
    // RF type field must equal the WorkNode kind so the per-kind card
    // component is selected via NodeTypes lookup.
    const byId = new Map(nodes.map((n) => [n.id, n.type]));
    expect(byId.get("l1")).toBe("llm_call");
    expect(byId.get("t1")).toBe("tool_call");
    expect(byId.get("d1")).toBe("delegate");
    expect(byId.get("c1")).toBe("compact");
    expect(byId.get("a1")).toBe("attachment");
  });

  it("classifies edges from llm_call to tool_call/delegate as `spawn`", () => {
    const cn = makeChatNode({
      nodes: [llm(), tool({ parentUuid: "l1" }), delegate({ parentUuid: "l1" })],
      edges: [],
    });
    const { edges } = layoutWorkFlow(cn);
    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.type === "spawn")).toBe(true);
  });

  it("classifies edges between two llm_calls as `continuation`", () => {
    const cn = makeChatNode({
      nodes: [llm({ id: "l1" }), llm({ id: "l2", parentUuid: "l1" })],
      edges: [],
    });
    const { edges } = layoutWorkFlow(cn);
    expect(edges).toHaveLength(1);
    expect(edges[0].type).toBe("continuation");
    expect(edges[0].source).toBe("l1");
    expect(edges[0].target).toBe("l2");
  });

  it("hops through tool_call's resultUserUuid: a follow-up llm_call whose parent is the tool_result user record routes back through the tool_call", () => {
    // l1 → t1 (parentUuid='l1') → result lives on user uuid 'u-res' →
    // l2 (parentUuid='u-res') should connect back to t1, NOT to a
    // missing 'u-res' node.
    const cn = makeChatNode({
      nodes: [
        llm({ id: "l1" }),
        tool({ id: "t1", parentUuid: "l1", resultUserUuid: "u-res" }),
        llm({ id: "l2", parentUuid: "u-res" }),
      ],
      edges: [],
    });
    const { edges } = layoutWorkFlow(cn);
    const incoming = edges.find((e) => e.target === "l2");
    expect(incoming).toBeTruthy();
    expect(incoming?.source).toBe("t1");
    expect(incoming?.type).toBe("continuation");
  });

  it("lays out left→right (LR): parent x < child x for spawn edges", () => {
    const cn = makeChatNode({
      nodes: [llm(), tool({ parentUuid: "l1" })],
      edges: [],
    });
    const { nodes } = layoutWorkFlow(cn);
    const a = nodes.find((n) => n.id === "l1")!;
    const b = nodes.find((n) => n.id === "t1")!;
    expect(a.position.x).toBeLessThan(b.position.x);
  });

  it("returns empty result for an empty WorkFlow without throwing", () => {
    const cn = makeChatNode({ nodes: [], edges: [] });
    const { nodes, edges } = layoutWorkFlow(cn);
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });

  it("uses per-kind sizing — delegate is wider than tool_call", () => {
    expect(WF_NODE_SIZE.delegate.width).toBeGreaterThan(WF_NODE_SIZE.tool_call.width);
    // attachment is the narrowest — it carries the least content per
    // card and shouldn't crowd the canvas.
    expect(WF_NODE_SIZE.attachment.width).toBeLessThan(
      WF_NODE_SIZE.tool_call.width,
    );
  });

  it("preserves the WorkNode reference inside data so cards can read every field", () => {
    const t1 = tool({ id: "tx", input: { pattern: "**/*.tsx" } });
    const cn = makeChatNode({ nodes: [t1], edges: [] });
    const { nodes } = layoutWorkFlow(cn);
    expect(nodes[0].data.workNode).toBe(t1);
  });

  it("flags hasIncomingEdge / hasOutgoingEdge correctly so handles can be hidden on isolated nodes", () => {
    const cn = makeChatNode({
      nodes: [llm({ id: "l1" }), tool({ id: "t1", parentUuid: "l1" })],
      edges: [],
    });
    const { nodes } = layoutWorkFlow(cn);
    const l = nodes.find((n) => n.id === "l1")!;
    const t = nodes.find((n) => n.id === "t1")!;
    expect(l.data.hasIncomingEdge).toBe(false);
    expect(l.data.hasOutgoingEdge).toBe(true);
    expect(t.data.hasIncomingEdge).toBe(true);
    expect(t.data.hasOutgoingEdge).toBe(false);
  });
});

// PR 2.1 step 4: when a single llm_call spawns multiple tool_calls,
// the next-round llm_call sees ALL their tool_results as input, but
// CC's parentUuid only chains through the LAST tool. layoutWorkFlow
// fans those edges in to reflect the actual information flow.
describe("layoutWorkFlow — multi-tool fan-in continuation", () => {
  it("emits continuation edges from EVERY sibling tool to the next llm_call", () => {
    // l1 → {t1, t2, t3} → l2. l2.parentUuid points at t3's
    // resultUserUuid (CC convention). All 3 tools must connect to l2.
    const cn = makeChatNode({
      nodes: [
        llm({ id: "l1" }),
        tool({ id: "t1", parentUuid: "l1", resultUserUuid: "u-t1" }),
        tool({ id: "t2", parentUuid: "l1", resultUserUuid: "u-t2" }),
        tool({ id: "t3", parentUuid: "l1", resultUserUuid: "u-t3" }),
        llm({ id: "l2", parentUuid: "u-t3" }),
      ],
      edges: [],
    });
    const { edges } = layoutWorkFlow(cn);
    const intoL2 = edges.filter((e) => e.target === "l2");
    expect(intoL2).toHaveLength(3);
    const sources = intoL2.map((e) => e.source).sort();
    expect(sources).toEqual(["t1", "t2", "t3"]);
    expect(intoL2.every((e) => e.type === "continuation")).toBe(true);
  });

  it("fan-in mixes tool_call + delegate siblings (both kinds reach the next llm_call)", () => {
    // l1 → {t1 (tool), d1 (delegate)} → l2.
    const cn = makeChatNode({
      nodes: [
        llm({ id: "l1" }),
        tool({ id: "t1", parentUuid: "l1", resultUserUuid: "u-t1" }),
        delegate({ id: "d1", parentUuid: "l1", resultUserUuid: "u-d1" }),
        llm({ id: "l2", parentUuid: "u-d1" }),
      ],
      edges: [],
    });
    const { edges } = layoutWorkFlow(cn);
    const intoL2 = edges.filter((e) => e.target === "l2");
    expect(intoL2).toHaveLength(2);
    expect(intoL2.map((e) => e.source).sort()).toEqual(["d1", "t1"]);
  });

  it("single-tool case unchanged (1 sibling = 1 continuation edge)", () => {
    // Sanity-check the regression: pre-PR 2.1 the single-tool case
    // emitted exactly one t1→l2 continuation; the fan-in path must
    // not duplicate that.
    const cn = makeChatNode({
      nodes: [
        llm({ id: "l1" }),
        tool({ id: "t1", parentUuid: "l1", resultUserUuid: "u-res" }),
        llm({ id: "l2", parentUuid: "u-res" }),
      ],
      edges: [],
    });
    const { edges } = layoutWorkFlow(cn);
    const intoL2 = edges.filter((e) => e.target === "l2");
    expect(intoL2).toHaveLength(1);
    expect(intoL2[0].source).toBe("t1");
  });

  it("two consecutive multi-tool rounds: each round's tools fan in to the round's next llm_call", () => {
    // Chain: l1 → {t1, t2} → l2 → {t3, t4} → l3.
    // Expected continuation edges into l2: from t1, t2.
    // Expected continuation edges into l3: from t3, t4.
    const cn = makeChatNode({
      nodes: [
        llm({ id: "l1" }),
        tool({ id: "t1", parentUuid: "l1", resultUserUuid: "u-t1" }),
        tool({ id: "t2", parentUuid: "l1", resultUserUuid: "u-t2" }),
        llm({ id: "l2", parentUuid: "u-t2" }),
        tool({ id: "t3", parentUuid: "l2", resultUserUuid: "u-t3" }),
        tool({ id: "t4", parentUuid: "l2", resultUserUuid: "u-t4" }),
        llm({ id: "l3", parentUuid: "u-t4" }),
      ],
      edges: [],
    });
    const { edges } = layoutWorkFlow(cn);
    const intoL2 = edges
      .filter((e) => e.target === "l2")
      .map((e) => e.source)
      .sort();
    const intoL3 = edges
      .filter((e) => e.target === "l3")
      .map((e) => e.source)
      .sort();
    expect(intoL2).toEqual(["t1", "t2"]);
    expect(intoL3).toEqual(["t3", "t4"]);
  });

  it("hasIncomingEdge / hasOutgoingEdge still correct under fan-in (every sibling tool now has outgoing)", () => {
    // Pre-PR 2.1 only the LAST tool had outgoing=true; siblings showed
    // no downstream handle. Fan-in fix: ALL siblings should have
    // hasOutgoingEdge=true.
    const cn = makeChatNode({
      nodes: [
        llm({ id: "l1" }),
        tool({ id: "t1", parentUuid: "l1", resultUserUuid: "u-t1" }),
        tool({ id: "t2", parentUuid: "l1", resultUserUuid: "u-t2" }),
        llm({ id: "l2", parentUuid: "u-t2" }),
      ],
      edges: [],
    });
    const { nodes } = layoutWorkFlow(cn);
    const t1 = nodes.find((n) => n.id === "t1")!;
    const t2 = nodes.find((n) => n.id === "t2")!;
    expect(t1.data.hasOutgoingEdge).toBe(true);
    expect(t2.data.hasOutgoingEdge).toBe(true);
  });
});

describe("preview helpers", () => {
  it("previewLlmCallText collapses whitespace + truncates", () => {
    const long = "a".repeat(300);
    expect(previewLlmCallText(llm({ text: "  hi  there  " }))).toBe("hi there");
    expect(previewLlmCallText(llm({ text: long }))).toMatch(/…$/);
    expect(previewLlmCallText(llm({ text: "" }))).toBe("");
  });

  it("llmCallThinkingLines counts newline-separated lines across all blocks", () => {
    expect(llmCallThinkingLines(llm({ thinking: [] }))).toBe(0);
    expect(
      llmCallThinkingLines(
        llm({
          thinking: [
            { text: "one\ntwo\nthree" }, // 3
            { text: "four" }, // 1
          ],
        }),
      ),
    ).toBe(4);
  });

  it("previewToolInput emits 'key: value' lines for top-level scalars and JSON-encodes nested values", () => {
    const out = previewToolInput(
      tool({ input: { pattern: "*.ts", path: "/a", flags: { case: false } } }),
    );
    expect(out).toContain("pattern: *.ts");
    expect(out).toContain("path: /a");
    expect(out.find((l) => l.startsWith("flags:"))).toBeTruthy();
  });

  it("previewToolResult takes first non-empty line of block content", () => {
    expect(
      previewToolResult(
        tool({ resultBlock: { content: "\n  hello world\nsecond line\n" } }),
      ),
    ).toBe("hello world");
    expect(
      previewToolResult(
        tool({ resultBlock: { content: [{ type: "text", text: "from-block-array" }] } }),
      ),
    ).toBe("from-block-array");
    expect(previewToolResult(tool())).toBe("");
  });

  it("delegateContentPreview truncates and trims content", () => {
    expect(delegateContentPreview(delegate({ content: "  short content  " }))).toBe(
      "short content",
    );
    expect(delegateContentPreview(delegate({ content: "x".repeat(500) }))).toMatch(/…$/);
  });

  it("compactSummaryPreview handles multi-line summary", () => {
    expect(
      compactSummaryPreview(compact({ summaryText: "first line\nsecond" })),
    ).toBe("first line");
  });

  it("attachmentLabel prefers filename, falls back to prompt, finally type", () => {
    expect(
      attachmentLabel(
        attach({ raw: { attachment: { filename: "src/App.tsx" } } }),
      ),
    ).toBe("src/App.tsx");
    expect(
      attachmentLabel(
        attach({
          attachmentType: "queued_command",
          raw: { attachment: { prompt: "do the thing" } },
        }),
      ),
    ).toBe("do the thing");
    expect(attachmentLabel(attach({ attachmentType: "skill_listing" }))).toBe(
      "skill_listing",
    );
  });
});
