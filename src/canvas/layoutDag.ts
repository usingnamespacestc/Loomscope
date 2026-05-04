// Map a flat ChatNode array onto React Flow nodes/edges with dagre-computed
// positions. Layout direction is left→right (LR) — ChatFlow's main axis.
//
// We render at most 3 attributes per ChatNode card so the dimensions are
// roughly stable; dagre needs node sizes to lay things out. If a future
// version of the card grows variable-height (e.g. multi-line tool list),
// switch dagre's `ranker` to `tight-tree` and feed actual measured sizes.

import dagre from "@dagrejs/dagre";
import type { Edge as RFEdge, Node as RFNode } from "@xyflow/react";

import {
  chatFoldIdFor,
  computeFoldProjection,
  type FoldProjection,
} from "@/canvas/foldProjection";
import type { ChatFoldNodeData } from "@/canvas/nodes/ChatFoldNodeCard";
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
type LayoutChatFoldRFNode = RFNode<ChatFoldNodeData, "chatFold">;
export type LayoutRFNode = ChatNodeRFNode | LayoutChatFoldRFNode;

// Approximate height of a ChatFoldNodeCard. Used as a layout hint;
// dagre also tolerates undersized hints — the actual card auto-grows
// with content. Slightly shorter than NODE_HEIGHT because the fold
// card has less chrome.
const FOLD_NODE_HEIGHT = 92;

// Public API: derive React Flow nodes/edges with positions from a
// ChatFlow + the set of compact ChatNode ids whose pre-compact range
// is currently folded. The fold set drives ``computeFoldProjection``;
// hidden range members are dropped from dagre, replaced upstream of
// each fold's host compact by a synthetic ``chatFold`` rfNode.
//
// When ``foldedCompactIds`` is empty (or nullish) the function
// degenerates to its v0.7 layout — no chatFold phantoms, no
// edge reroute.
export function layoutChatFlow(
  chatFlow: ChatFlow,
  foldedCompactIds?: Set<string>,
): {
  nodes: LayoutRFNode[];
  edges: RFEdge[];
} {
  const projection = computeFoldProjection(
    chatFlow,
    foldedCompactIds ?? new Set(),
  );

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: "LR",
    nodesep: NODESEP,
    ranksep: RANKSEP,
    marginx: 20,
    marginy: 20,
  });

  // dagre nodes: skip hidden ChatNodes; emit a phantom chatFold for
  // each active fold host BEFORE walking edges so g.setEdge calls find
  // both endpoints registered.
  for (const cn of chatFlow.chatNodes) {
    if (projection.hidden.has(cn.id)) continue;
    g.setNode(cn.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const hostId of projection.activeFoldHostIds) {
    g.setNode(chatFoldIdFor(hostId), {
      width: NODE_WIDTH,
      height: FOLD_NODE_HEIGHT,
    });
  }

  const edges: RFEdge[] = [];

  // Edges with fold-aware reroute. For each `cn -> parent` continuation
  // edge in the original flow we pick exactly one of:
  //   - drop  (both endpoints absorbed into the same fold)
  //   - normal cn  ↔  parent (both visible, default v0.7 behaviour)
  //   - fold(parent) → cn  (visible cn whose parent was hidden)
  //   - parent → fold(cn)  (hidden cn fed from a visible parent — only
  //                         emit ONCE per fold to avoid n parallel
  //                         entry edges when n hidden range members
  //                         share a visible parent)
  const emittedFoldEntries = new Set<string>();
  // v0.8.1 #8: track which fold phantoms received at least one
  // `parent → fold` edge (= visible upstream ChatNode feeding into
  // the absorbed range). Drives the card's left-handle visibility.
  const foldsWithIncoming = new Set<string>();
  for (const cn of chatFlow.chatNodes) {
    const p = cn.parentChatNodeId;
    if (!p) continue;
    const cnHidden = projection.hidden.has(cn.id);
    const pHidden = projection.hidden.has(p);
    if (cnHidden && pHidden) continue; // wholly inside fold(s)

    if (!cnHidden && !pHidden) {
      g.setEdge(p, cn.id);
      const targetModel = lastModelOf(cn);
      edges.push({
        id: `e-${p}->${cn.id}`,
        source: p,
        target: cn.id,
        type: "continuation",
        data: { targetModel },
      });
      continue;
    }

    if (!cnHidden && pHidden) {
      // fold-output-right → cn (cn might be the host or a sibling
      // fork that emerged from inside the range). The host case is
      // the natural continuation (chatFold → host compact); sibling
      // forks are extra branches off internal range members.
      const foldHost = projection.foldByHidden.get(p);
      if (!foldHost) continue;
      const foldId = chatFoldIdFor(foldHost);
      g.setEdge(foldId, cn.id);
      const targetModel = lastModelOf(cn);
      edges.push({
        id: `e-${foldId}->${cn.id}`,
        source: foldId,
        sourceHandle: "fold-output-right",
        target: cn.id,
        type: "continuation",
        data: { targetModel },
      });
      continue;
    }

    // cnHidden && !pHidden: visible parent feeds into the fold. Dedupe
    // on (parent, fold) so we don't emit n parallel edges when several
    // hidden range members share a visible parent (rare but defensive).
    const foldHost = projection.foldByHidden.get(cn.id);
    if (!foldHost) continue;
    const foldId = chatFoldIdFor(foldHost);
    const key = `${p}->${foldId}`;
    if (emittedFoldEntries.has(key)) continue;
    emittedFoldEntries.add(key);
    foldsWithIncoming.add(foldId); // v0.8.1 #8 — drives left-handle visibility
    g.setEdge(p, foldId);
    edges.push({
      id: `e-${p}->${foldId}`,
      source: p,
      target: foldId,
      targetHandle: "fold-input",
      type: "continuation",
      // No targetModel — the fold target isn't a real LLM turn, so the
      // edge tooltip would have nothing meaningful to show.
    });
  }

  // v0.8.1 #6: logical edges (compact ChatNode → pre-compact tail) are
  // no longer rendered. Users found the dashed反向弧 visually noisy
  // and it competed with the model-tooltip path on hover. The
  // underlying data (compactMetadata.logicalParentChatNodeId) is still
  // populated by parser/jsonl.ts and consumed by computeCompactRange
  // for fold projection — only the visual edge path is gone.

  dagre.layout(g);

  // Pre-compute which (visible) nodes have parents/children — drives
  // Handle visibility on each card. Hidden nodes don't render so we
  // skip them; chatFold phantoms always have both handles visible
  // (they're declared statically in ChatFoldNodeCard).
  const parentIds = new Set<string>();
  const childIds = new Set<string>();
  const childCountOf = new Map<string, number>();
  for (const cn of chatFlow.chatNodes) {
    if (projection.hidden.has(cn.id)) continue;
    if (cn.parentChatNodeId && !projection.hidden.has(cn.parentChatNodeId)) {
      childIds.add(cn.id);
      parentIds.add(cn.parentChatNodeId);
      childCountOf.set(
        cn.parentChatNodeId,
        (childCountOf.get(cn.parentChatNodeId) ?? 0) + 1,
      );
    } else if (cn.parentChatNodeId && projection.hidden.has(cn.parentChatNodeId)) {
      // Parent is hidden — visually the card has an incoming edge from
      // the chatFold phantom, so flag hasIncoming.
      childIds.add(cn.id);
    }
  }

  const chatNodeRfs: ChatNodeRFNode[] = [];
  for (const cn of chatFlow.chatNodes) {
    if (projection.hidden.has(cn.id)) continue;
    const pos = g.node(cn.id);
    const x = (pos?.x ?? 0) - NODE_WIDTH / 2;
    const y = (pos?.y ?? 0) - NODE_HEIGHT / 2;
    chatNodeRfs.push({
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
    });
  }

  const foldRfs: LayoutChatFoldRFNode[] = [];
  for (const hostId of projection.activeFoldHostIds) {
    const foldId = chatFoldIdFor(hostId);
    const pos = g.node(foldId);
    const x = (pos?.x ?? 0) - NODE_WIDTH / 2;
    const y = (pos?.y ?? 0) - FOLD_NODE_HEIGHT / 2;
    const lastMemberId = projection.lastMemberByFold.get(hostId) ?? "";
    const count = projection.countByFold.get(hostId) ?? 0;
    const preTokens = projection.preTokensByFold.get(hostId);
    foldRfs.push({
      id: foldId,
      type: "chatFold",
      position: { x, y },
      data: {
        hostCompactId: hostId,
        count,
        lastMemberId,
        preTokens,
        hasIncomingEdge: foldsWithIncoming.has(foldId),
      },
    });
  }

  return { nodes: [...chatNodeRfs, ...foldRfs], edges };
}

// Re-export so consumers (tests, future tooling) can introspect the
// projection alongside layout output without re-importing the helper.
export type { FoldProjection };

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

// v0.8.1 #9: "this node only" file-changes — strips the cumulative
// git working-tree dirty set inherited from ancestors, keeping just
// what THIS turn introduced.
//
// Algorithm:
//   parentSnap = nearest ancestor (via parentChatNodeId) whose
//                fileHistorySnapshots is non-empty; if none found,
//                empty set
//   selfSnap   = unionTrackedFiles(cn.meta.fileHistorySnapshots)
//   selfDelta  = (selfSnap \ parentSnap) ∪ distinctToolUseFiles(cn)
//
// Why the union with tool_use: a Bash / sub-agent write can flip a
// file already-dirty in the parent's snap. Diff alone would drop it,
// but the user explicitly told the assistant to write that file —
// it belongs in "this node's changes". And conversely: tool_use can
// list a file (e.g. .gitignore'd) that snap never sees.
export function nodeOwnFileChanges(
  cn: ChatNode,
  chatFlow: ChatFlow,
): Set<string> {
  const selfSnap = distinctTouchedFiles(cn);
  const parentSnap = nearestAncestorSnapshotPaths(cn, chatFlow);
  const out = new Set<string>();
  for (const p of selfSnap) {
    if (!parentSnap.has(p)) out.add(p);
  }
  for (const p of distinctToolUseFiles(cn)) out.add(p);
  return out;
}

// Walk parentChatNodeId until we hit an ancestor with a non-empty
// fileHistorySnapshots; return the union of its trackedFiles paths.
// Empty set when no such ancestor exists. Bounded by chatFlow size
// (cycles are guarded but shouldn't occur in well-formed flows).
function nearestAncestorSnapshotPaths(
  cn: ChatNode,
  chatFlow: ChatFlow,
): Set<string> {
  const byId = new Map(chatFlow.chatNodes.map((c) => [c.id, c]));
  const guard = new Set<string>();
  let cursor: ChatNode | undefined = cn.parentChatNodeId
    ? byId.get(cn.parentChatNodeId)
    : undefined;
  while (cursor && !guard.has(cursor.id)) {
    guard.add(cursor.id);
    const snaps = cursor.meta.fileHistorySnapshots ?? [];
    if (snaps.length > 0) {
      const out = new Set<string>();
      for (const s of snaps) {
        for (const f of s.trackedFiles) out.add(f);
      }
      return out;
    }
    cursor = cursor.parentChatNodeId ? byId.get(cursor.parentChatNodeId) : undefined;
  }
  return new Set();
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
