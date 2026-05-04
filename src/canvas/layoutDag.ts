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
  // Distinct file paths touched in the turn, derived from
  // ChatNode.meta.fileHistorySnapshots[*].trackedFiles. Used for the
  // 📁 N stats chip on ChatNodeCard. 0 = no snapshots bound (badge
  // hidden).
  fileTouchCount: number;
  // v0.8 M5: number of immediate children of this ChatNode in the
  // (possibly merged) ChatFlow. Drives the ⑂ N fork indicator chip
  // on ChatNodeCard — surfaces when ≥2, signals "this is a fork
  // point" without forcing a separate fork-only data path (in-session
  // siblings + cross-session /branch siblings are both just multi-
  // children at this layer).
  childCount: number;
  // Token bar inputs — last llm_call's input + cache 表示该轮 context window 占用.
  // maxContextTokens 由 last llm_call 的 model 字段决定（[1m] 后缀 = 1M, 其它 = 200k）.
  contextTokens: number;
  maxContextTokens: number;
  // Slash command info (cn.slashCommand mirrored here so the card doesn't
  // need to drill back into chatNode object — keeps the prop interface
  // self-contained for tests).
  slashCommand: ChatNode["slashCommand"];
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
      // targetModel = the model that ran ON this turn (the child of the
      // edge). Edge tooltip shows this so the user can see "Opus" vs
      // "Sonnet" mid-session switches at a glance.
      const targetModel = lastModelOf(cn);
      edges.push({
        id: `e-${cn.parentChatNodeId}->${cn.id}`,
        source: cn.parentChatNodeId,
        target: cn.id,
        type: "continuation",
        data: { targetModel },
      });
    }
  }

  // v0.7 M4: emit logical edges from each compact ChatNode back to the
  // pre-compact tail ChatNode that its compactMetadata.logicalParentChatNodeId
  // references. Visually a反向弧 (backward arc) per design-visual-language —
  // dashed浅灰. These edges deliberately do NOT call g.setEdge so dagre's
  // LR layout stays driven only by parentChatNodeId continuation chains;
  // tainting the layout with logical back-pointers would re-rank the
  // pre-compact tail and visually break the time-ordered horizontal flow.
  const chatNodeIds = new Set(chatFlow.chatNodes.map((c) => c.id));
  for (const cn of chatFlow.chatNodes) {
    if (!cn.isCompactSummary) continue;
    const lpcn = cn.compactMetadata?.logicalParentChatNodeId;
    if (!lpcn) continue;
    // Defensive: skip when the target ChatNode isn't in this scope (=
    // pre-compact tail was outside the synthetic ChatFlow being
    // rendered, or compactMetadata has a stale id).
    if (!chatNodeIds.has(lpcn)) continue;
    edges.push({
      id: `e-logical-${cn.id}->${lpcn}`,
      source: cn.id,
      target: lpcn,
      type: "logical",
    });
  }

  dagre.layout(g);

  // Pre-compute which nodes have parents/children — drives Handle visibility.
  // v0.8 M5: also count children per parent for the ⑂ N fork indicator.
  const parentIds = new Set<string>();
  const childIds = new Set<string>();
  const childCountOf = new Map<string, number>();
  for (const cn of chatFlow.chatNodes) {
    if (cn.parentChatNodeId) {
      childIds.add(cn.id);
      parentIds.add(cn.parentChatNodeId);
      childCountOf.set(
        cn.parentChatNodeId,
        (childCountOf.get(cn.parentChatNodeId) ?? 0) + 1,
      );
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
      data: deriveCardData(
        cn,
        {
          hasIncomingEdge: childIds.has(cn.id),
          hasOutgoingEdge: parentIds.has(cn.id),
        },
        childCountOf.get(cn.id) ?? 0,
      ),
    };
  });

  return { nodes, edges };
}

const DEFAULT_MAX_CONTEXT_TOKENS = 200_000; // fallback for unknown models

// Default model → context-window table. CC's `getModelCapability()` only
// works for internal users (USER_TYPE='ant', reads ~/.claude/cache/
// model-capabilities.json fetched from Anthropic API). External users
// get undefined — so we ship sensible defaults + let users override in
// settings panel (v0.4).
//
// Defaults reflect Loomscope author's actual usage:
//   Opus 4.7 (default) → 1M context (selected via /model in CC)
//   Sonnet 4.6        → 200k
//   Haiku 4.5         → 200k
//
// CC strips the [1m] suffix before writing model field to jsonl
// (src/utils/model/model.ts:501), so we can't read the user's runtime
// 1M opt-in directly. The defaults below assume the typical Loomscope
// user runs Opus on 1M; if an Opus session was actually 200k (rare),
// the bar will under-state usage — user can override in settings.
//
// Order matters: longest-prefix-first (specific over general).
export const MODEL_CONTEXT_WINDOW: Array<[RegExp, number]> = [
  [/claude-opus/i, 1_000_000],
  [/claude-sonnet/i, 200_000],
  [/claude-haiku/i, 200_000],
  // Future overrides land in user settings (v0.4) and prepend to this list.
];

export function maxContextForModel(model?: string): number {
  if (!model) return DEFAULT_MAX_CONTEXT_TOKENS;
  for (const [pattern, max] of MODEL_CONTEXT_WINDOW) {
    if (pattern.test(model)) return max;
  }
  return DEFAULT_MAX_CONTEXT_TOKENS;
}

// Skip llm_call records that aren't real API responses:
//   - model === "<synthetic>" — CC injects these for rate-limit (429),
//     interruption, or other harness-side fake assistant records.
//     Their usage fields are all 0 because no API call happened.
//   - errors[] non-empty — error responses also can't represent real
//     context state.
// Without this filter, a 429 at the end of a turn pins TokenBar to 0
// and ribbon model to "<synthetic>", losing the per-turn model
// signal even though the turn ran multiple real LLM calls before.
function isRealLlmCall(n: { model?: string; errors?: unknown[] }): boolean {
  if (n.model === "<synthetic>") return false;
  if (n.errors && n.errors.length > 0) return false;
  return true;
}

// Last *real* llm_call's model in a ChatNode (skipping <synthetic> +
// errored calls), or undefined when there's no real llm_call (slash
// commands, compact-summary-only ChatNodes, fully-rate-limited turn).
function lastModelOf(cn: ChatNode): string | undefined {
  const llms = cn.workflow.nodes.filter(
    (n): n is Extract<typeof n, { kind: "llm_call" }> =>
      n.kind === "llm_call" && isRealLlmCall(n),
  );
  if (llms.length === 0) return undefined;
  return llms[llms.length - 1].model;
}

// Compute total context tokens for a single llm_call usage record.
function llmCallContextTokens(usage: Record<string, unknown> | undefined): number {
  if (!usage) return 0;
  const num = (k: string) => (typeof usage[k] === "number" ? (usage[k] as number) : 0);
  return num("input_tokens") + num("cache_creation_input_tokens") + num("cache_read_input_tokens");
}

// Pull `cache_creation + cache_read + input_tokens` from the *last* llm_call's
// usage — that snapshot represents how much context CC sent on the most
// recent LLM invocation in this ChatNode (which is the relevant denominator
// for "how full is the context window after this turn"). max derived from
// the model name via MODEL_CONTEXT_WINDOW table.
function deriveContextTokens(cn: ChatNode): {
  contextTokens: number;
  maxContextTokens: number;
} {
  // Mirrors lastModelOf — skip <synthetic> / errored calls so a
  // rate-limit (429) tail record doesn't pin the bar to 0.
  const llms = cn.workflow.nodes.filter(
    (n): n is Extract<typeof n, { kind: "llm_call" }> =>
      n.kind === "llm_call" && isRealLlmCall(n),
  );
  if (llms.length === 0)
    return { contextTokens: 0, maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS };
  const last = llms[llms.length - 1];
  return {
    contextTokens: llmCallContextTokens(last.usage),
    maxContextTokens: maxContextForModel(last.model),
  };
}

function deriveCardData(
  cn: ChatNode,
  edges: { hasIncomingEdge: boolean; hasOutgoingEdge: boolean },
  childCount: number,
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
    fileTouchCount: distinctTouchedFiles(cn).size,
    childCount,
    contextTokens,
    maxContextTokens,
    slashCommand: cn.slashCommand,
    hasIncomingEdge: edges.hasIncomingEdge,
    hasOutgoingEdge: edges.hasOutgoingEdge,
  };
}

// Union of every file path tracked across this ChatNode's bound
// file-history-snapshots. v0.7 keeps both `isUpdate=true` and false
// snapshots in the union — `isUpdate` snapshots tend to repeat the
// same path set as the prior non-update for the same turn (CC re-emits
// snapshots when assistant follow-ups land), so unioning is faithful
// to "what files did this turn touch" without double-counting.
export function distinctTouchedFiles(cn: ChatNode): Set<string> {
  const out = new Set<string>();
  for (const s of cn.meta.fileHistorySnapshots ?? []) {
    for (const f of s.trackedFiles) out.add(f);
  }
  return out;
}

// File paths that the ChatNode's WorkFlow explicitly mutated through a
// tool_use. Used by the M1c side-by-side comparison in DrillPanel to
// surface side-effect changes — paths in `distinctTouchedFiles(cn)`
// but missing from `distinctToolUseFiles(cn)` were touched by Bash /
// sub-agents / hooks rather than a direct Edit/Write call.
//
// Coverage rationale (v0.7):
//   Edit / Write / MultiEdit / NotebookEdit carry the path in the
//   tool_use input. Bash is omitted because the path lives in
//   stdout/stderr, where extracting it is a stylistic-pattern guess
//   that 1) is wrong often and 2) belongs in the v0.10 polish bucket
//   alongside automatic side-effect classification.
export function distinctToolUseFiles(cn: ChatNode): Set<string> {
  const out = new Set<string>();
  for (const n of cn.workflow.nodes) {
    if (n.kind !== "tool_call") continue;
    const input = n.input as Record<string, unknown> | undefined;
    if (!input) continue;
    if (n.toolName === "Edit" || n.toolName === "Write" || n.toolName === "MultiEdit") {
      const p = input["file_path"];
      if (typeof p === "string" && p.length > 0) out.add(p);
    } else if (n.toolName === "NotebookEdit") {
      const p = input["notebook_path"];
      if (typeof p === "string" && p.length > 0) out.add(p);
    }
  }
  return out;
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
