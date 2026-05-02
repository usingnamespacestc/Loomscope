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

// Match Agentloom's w-52 (208px) for visual family resemblance.
// Height auto-grows with content; dagre uses NODE_HEIGHT only as a layout
// hint for rank computation.
export const NODE_WIDTH = 208;
export const NODE_HEIGHT = 150;
export const RANKSEP = 90;
export const NODESEP = 24;

export interface ChatNodeRFData extends Record<string, unknown> {
  chatNode: ChatNode;
  // Pre-computed previews so the card doesn't repeat work each render.
  userPreview: string;
  assistantPreview: string;
  toolCount: number;
  llmCount: number;
  totalThinkingChars: number;
  isCompactSummary: boolean;
  // Token bar inputs — last llm_call's input + cache 表示该轮 context window 占用.
  contextTokens: number;
  maxContextTokens: number | null;
  // Edge presence — drives whether handle dots show.
  hasIncomingEdge: boolean;
  hasOutgoingEdge: boolean;
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

  // Pre-compute which nodes have parents/children — drives Handle visibility.
  const parentIds = new Set<string>();
  const childIds = new Set<string>();
  for (const cn of chatFlow.chatNodes) {
    if (cn.parentChatNodeId) {
      childIds.add(cn.id);
      parentIds.add(cn.parentChatNodeId);
    }
  }

  const nodes: ChatNodeRFNode[] = chatFlow.chatNodes.map((cn) => {
    const pos = g.node(cn.id);
    // dagre returns the *center*; React Flow expects top-left.
    const x = (pos?.x ?? 0) - NODE_WIDTH / 2;
    const y = (pos?.y ?? 0) - NODE_HEIGHT / 2;
    return {
      id: cn.id,
      type: "chatNode",
      position: { x, y },
      data: deriveCardData(cn, {
        hasIncomingEdge: childIds.has(cn.id),
        hasOutgoingEdge: parentIds.has(cn.id),
      }),
    };
  });

  return { nodes, edges };
}

const DEFAULT_MAX_CONTEXT_TOKENS = 200_000; // claude-opus-4 / sonnet-4 default

// Pull `cache_creation + cache_read + input_tokens` from the *last* llm_call's
// usage — that snapshot represents how much context CC sent on the most
// recent LLM invocation in this ChatNode (which is the relevant denominator
// for "how full is the context window after this turn").
function deriveContextTokens(cn: ChatNode): {
  contextTokens: number;
  maxContextTokens: number | null;
} {
  const llms = cn.workflow.nodes.filter((n) => n.kind === "llm_call");
  if (llms.length === 0) return { contextTokens: 0, maxContextTokens: null };
  const last = llms[llms.length - 1];
  if (last.kind !== "llm_call") return { contextTokens: 0, maxContextTokens: null };
  const u = (last.usage ?? {}) as Record<string, unknown>;
  const num = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
  const contextTokens =
    num("input_tokens") + num("cache_creation_input_tokens") + num("cache_read_input_tokens");
  // No source-of-truth for max yet; future v0.3+ can read last.model.
  return { contextTokens, maxContextTokens: null };
}

function deriveCardData(
  cn: ChatNode,
  edges: { hasIncomingEdge: boolean; hasOutgoingEdge: boolean },
): ChatNodeRFData {
  const { contextTokens, maxContextTokens } = deriveContextTokens(cn);
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
    contextTokens,
    maxContextTokens,
    hasIncomingEdge: edges.hasIncomingEdge,
    hasOutgoingEdge: edges.hasOutgoingEdge,
  };
}

export const TOKEN_BAR_DEFAULT_MAX = DEFAULT_MAX_CONTEXT_TOKENS;

export function formatTokensKM(n: number | null | undefined): string {
  if (n == null) return "";
  const M = 1_000_000;
  const K = 1_000;
  if (n >= M) {
    const v = n / M;
    return v >= 10 || v % 1 === 0 ? `${Math.round(v)}M` : `${v.toFixed(1)}M`;
  }
  const v = n / K;
  if (v < 1) return `${n}`;
  return v >= 10 || v % 1 === 0 ? `${Math.round(v)}k` : `${v.toFixed(1)}k`;
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
