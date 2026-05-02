// Map a flat ChatNode array onto React Flow nodes/edges with dagre-computed
// positions. Layout direction is left→right (LR) — ChatFlow's main axis.
//
// We render at most 3 attributes per ChatNode card so the dimensions are
// roughly stable; dagre needs node sizes to lay things out. If a future
// version of the card grows variable-height (e.g. multi-line tool list),
// switch dagre's `ranker` to `tight-tree` and feed actual measured sizes.

import dagre from "@dagrejs/dagre";
import type { Edge as RFEdge, Node as RFNode } from "@xyflow/react";

import type { ChatFlow, ChatNode } from "@/data/types";

export const NODE_WIDTH = 320;
export const NODE_HEIGHT = 130;
export const RANKSEP = 90;
export const NODESEP = 30;

export interface ChatNodeRFData extends Record<string, unknown> {
  chatNode: ChatNode;
  // Pre-computed previews so the card doesn't repeat work each render.
  userPreview: string;
  assistantPreview: string;
  toolCount: number;
  llmCount: number;
  totalThinkingChars: number;
  isCompactSummary: boolean;
}

export type ChatNodeRFNode = RFNode<ChatNodeRFData, "chatNode">;

// Public API: derive React Flow nodes/edges with positions from a ChatFlow.
export function layoutChatFlow(chatFlow: ChatFlow): {
  nodes: ChatNodeRFNode[];
  edges: RFEdge[];
} {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: "LR",
    nodesep: NODESEP,
    ranksep: RANKSEP,
    marginx: 20,
    marginy: 20,
  });

  for (const cn of chatFlow.chatNodes) {
    g.setNode(cn.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  const edges: RFEdge[] = [];
  for (const cn of chatFlow.chatNodes) {
    if (cn.parentChatNodeId) {
      g.setEdge(cn.parentChatNodeId, cn.id);
      edges.push({
        id: `e-${cn.parentChatNodeId}->${cn.id}`,
        source: cn.parentChatNodeId,
        target: cn.id,
        type: "continuation",
      });
    }
  }

  dagre.layout(g);

  const nodes: ChatNodeRFNode[] = chatFlow.chatNodes.map((cn) => {
    const pos = g.node(cn.id);
    // dagre returns the *center*; React Flow expects top-left.
    const x = (pos?.x ?? 0) - NODE_WIDTH / 2;
    const y = (pos?.y ?? 0) - NODE_HEIGHT / 2;
    return {
      id: cn.id,
      type: "chatNode",
      position: { x, y },
      data: deriveCardData(cn),
    };
  });

  return { nodes, edges };
}

function deriveCardData(cn: ChatNode): ChatNodeRFData {
  return {
    chatNode: cn,
    userPreview: previewUserContent(cn.userMessage.content),
    assistantPreview: lastAssistantPreview(cn),
    toolCount: cn.workflow.nodes.filter(
      (n) => n.kind === "tool_call" || n.kind === "delegate",
    ).length,
    llmCount: cn.workflow.nodes.filter((n) => n.kind === "llm_call").length,
    totalThinkingChars: cn.workflow.nodes.reduce((acc, n) => {
      if (n.kind !== "llm_call") return acc;
      return acc + n.thinking.reduce((a, t) => a + (t.text?.length ?? 0), 0);
    }, 0),
    isCompactSummary: cn.isCompactSummary,
  };
}

const PREVIEW_LEN = 80;

export function previewUserContent(content: unknown): string {
  if (typeof content === "string") return truncate(content.replace(/\s+/g, " ").trim(), PREVIEW_LEN);
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as { type?: string; text?: unknown };
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          return truncate(b.text.replace(/\s+/g, " ").trim(), PREVIEW_LEN);
        }
      }
    }
  }
  return "";
}

export function lastAssistantPreview(cn: ChatNode): string {
  const llms = cn.workflow.nodes.filter((n) => n.kind === "llm_call");
  if (llms.length === 0) return "";
  // Prefer the *last* llm_call's text (the agent's final reply this turn).
  for (let i = llms.length - 1; i >= 0; i -= 1) {
    const n = llms[i];
    if (n.kind === "llm_call" && n.text?.trim()) {
      return truncate(n.text.replace(/\s+/g, " ").trim(), PREVIEW_LEN);
    }
  }
  return "";
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
