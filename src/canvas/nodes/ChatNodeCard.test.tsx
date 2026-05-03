// Render tests for ChatNodeCard's compact branch (v0.7 M2).
//
// Goal: verify the三色 chrome by trigger + dashed border + new drill
// affordance buttons render correctly. The non-compact branch is
// covered by the broader canvas + e2e probe; this file focuses on the
// compact-specific spec from design-visual-language.md and design
// choice 1C' / 2A.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import type { ReactNode } from "react";

import { ChatNodeCard } from "@/canvas/nodes/ChatNodeCard";
import type { ChatNode, CompactNode, LlmCallNode } from "@/data/types";

function withRF(node: ReactNode) {
  return <ReactFlowProvider>{node}</ReactFlowProvider>;
}

function makeChatNode(overrides: Partial<ChatNode> = {}): ChatNode {
  return {
    kind: "chat",
    id: "p-compact-1",
    parentChatNodeId: null,
    rootUserUuid: "u-1",
    userMessage: { uuid: "u-1", content: "summary text", attachments: [] },
    workflow: { nodes: [], edges: [] },
    trigger: "user",
    isCompactSummary: true,
    meta: {},
    ...overrides,
  };
}

function makeCompactMeta(extra: Partial<CompactNode> = {}): CompactNode {
  return {
    id: "compact-wn-1",
    kind: "compact",
    parentUuid: null,
    summaryText: "previous discussion summarized",
    ...extra,
  };
}

function llmCallNode(id = "l1"): LlmCallNode {
  return {
    id,
    kind: "llm_call",
    parentUuid: null,
    text: "post-compact reply",
    thinking: [],
  };
}

function nodeProps(cn: ChatNode) {
  return {
    id: cn.id,
    type: "chatNode",
    data: {
      chatNode: cn,
      userPreview: "summary text preview",
      assistantPreview: "",
      toolCount: 0,
      llmCount: cn.workflow.nodes.filter((n) => n.kind === "llm_call").length,
      totalThinkingChars: 0,
      isCompactSummary: cn.isCompactSummary,
      fileTouchCount: 0,
      contextTokens: 0,
      maxContextTokens: 200_000,
      slashCommand: cn.slashCommand,
      hasIncomingEdge: false,
      hasOutgoingEdge: false,
    },
    selected: false,
    dragging: false,
    isConnectable: false,
    zIndex: 0,
    selectable: true,
    deletable: true,
    draggable: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    width: 200,
    height: 100,
    sourcePosition: undefined,
    targetPosition: undefined,
    dragHandle: undefined,
    parentId: undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("ChatNodeCard — compact branch", () => {
  it("auto trigger uses teal palette, dashed border, '(auto)' chip text", () => {
    const cn = makeChatNode({
      compactMetadata: makeCompactMeta({ trigger: "auto", preTokens: 92_300 }),
      workflow: { nodes: [makeCompactMeta()], edges: [] },
    });
    render(withRF(<ChatNodeCard {...nodeProps(cn)} />));
    const card = screen.getByTestId(`chat-node-${cn.id}`);
    expect(card.dataset.compactTrigger).toBe("auto");
    expect(card.className).toMatch(/border-dashed/);
    expect(card.className).toMatch(/teal/);
    expect(screen.getByText(/⊞ compact \(auto\)/)).toBeTruthy();
    // preTokens chip rendered (92K formatted).
    expect(screen.getByText(/· 92K/)).toBeTruthy();
    // Trigger-known case: no "trigger unknown" badge.
    expect(screen.queryByTestId("compact-trigger-unknown")).toBeNull();
  });

  it("manual trigger uses purple palette + '(manual)' chip text", () => {
    const cn = makeChatNode({
      compactMetadata: makeCompactMeta({ trigger: "manual", preTokens: 50_000 }),
      workflow: { nodes: [makeCompactMeta()], edges: [] },
    });
    render(withRF(<ChatNodeCard {...nodeProps(cn)} />));
    const card = screen.getByTestId(`chat-node-${cn.id}`);
    expect(card.dataset.compactTrigger).toBe("manual");
    expect(card.className).toMatch(/border-dashed/);
    expect(card.className).toMatch(/purple/);
    expect(screen.getByText(/⊞ compact \(manual\)/)).toBeTruthy();
  });

  it("failed trigger uses rose palette + '(failed)' chip text", () => {
    const cn = makeChatNode({
      compactMetadata: makeCompactMeta({ trigger: "failed" }),
      workflow: { nodes: [makeCompactMeta()], edges: [] },
    });
    render(withRF(<ChatNodeCard {...nodeProps(cn)} />));
    const card = screen.getByTestId(`chat-node-${cn.id}`);
    expect(card.dataset.compactTrigger).toBe("failed");
    expect(card.className).toMatch(/rose/);
    expect(screen.getByText(/⊞ compact \(failed\)/)).toBeTruthy();
  });

  it("missing trigger falls back to teal + 'trigger unknown' badge (design choice 2A)", () => {
    const cn = makeChatNode({
      compactMetadata: makeCompactMeta({ trigger: undefined }),
      workflow: { nodes: [makeCompactMeta()], edges: [] },
    });
    render(withRF(<ChatNodeCard {...nodeProps(cn)} />));
    const card = screen.getByTestId(`chat-node-${cn.id}`);
    expect(card.dataset.compactTrigger).toBe("auto");
    expect(card.className).toMatch(/teal/);
    expect(screen.getByText(/⊞ compact \(auto\)/)).toBeTruthy();
    // Distinguishes "real auto" from "trigger missing" via the gray badge.
    expect(screen.getByTestId("compact-trigger-unknown")).toBeTruthy();
  });

  it("renders '⤢ 展开 pre-compact' enabled when compact has resolvable logicalParentChatNodeId (M3)", () => {
    const cn = makeChatNode({
      compactMetadata: makeCompactMeta({
        trigger: "auto",
        logicalParentChatNodeId: "p-pre-tail",
      }),
      workflow: { nodes: [makeCompactMeta()], edges: [] },
    });
    render(withRF(<ChatNodeCard {...nodeProps(cn)} />));
    const btn = screen.getByTestId(`compact-pre-${cn.id}`) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toMatch(/展开 pre-compact/);
  });

  it("disables '⤢ 展开 pre-compact' when logicalParentChatNodeId is missing (M3)", () => {
    const cn = makeChatNode({
      compactMetadata: makeCompactMeta({ trigger: "auto" }), // no logicalParentChatNodeId
      workflow: { nodes: [makeCompactMeta()], edges: [] },
    });
    render(withRF(<ChatNodeCard {...nodeProps(cn)} />));
    const btn = screen.getByTestId(`compact-pre-${cn.id}`) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toMatch(/logicalParentUuid/);
  });

  it("shows '进入工作流' button when inner workflow has llm_call (drill into post-compact continuation)", () => {
    const cn = makeChatNode({
      compactMetadata: makeCompactMeta({ trigger: "auto" }),
      workflow: { nodes: [makeCompactMeta(), llmCallNode()], edges: [] },
    });
    render(withRF(<ChatNodeCard {...nodeProps(cn)} />));
    expect(screen.getByTestId(`enter-workflow-${cn.id}`)).toBeTruthy();
  });

  it("hides '进入工作流' button when inner workflow has no llm_call (3/131 edge case)", () => {
    const cn = makeChatNode({
      compactMetadata: makeCompactMeta({ trigger: "auto" }),
      workflow: { nodes: [makeCompactMeta()], edges: [] },
    });
    render(withRF(<ChatNodeCard {...nodeProps(cn)} />));
    expect(screen.queryByTestId(`enter-workflow-${cn.id}`)).toBeNull();
    // pre-compact button is independent of llm_call presence.
    expect(screen.getByTestId(`compact-pre-${cn.id}`)).toBeTruthy();
  });
});
