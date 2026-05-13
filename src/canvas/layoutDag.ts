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
import type { AwaySummaryNodeData } from "@/canvas/nodes/AwaySummaryNodeCard";
import type { ChatFoldNodeData } from "@/canvas/nodes/ChatFoldNodeCard";
import type { ChatFlow, ChatNode } from "@/data/types";

// v1.2 R5: synthetic id prefix for awaySummary nodes. Stable per-host
// so the React Flow reconciler doesn't churn across re-layouts when
// `cn.meta.awaySummary.uuid` is identical.
export function awaySummaryIdFor(hostChatNodeId: string): string {
  return `awaySummary-${hostChatNodeId}`;
}
export function isAwaySummaryId(id: string): boolean {
  return id.startsWith("awaySummary-");
}

// Match Agentloom's w-52 (208px) for visual family resemblance.
// Height auto-grows with content; dagre uses NODE_HEIGHT only as a
// layout hint for rank computation.
//
// 2026-05-08 bump 150 → 260: cards have accreted chrome (TokenBar,
// multi-row stats with flex-wrap, hybrid InnerCompactBanner, NodeId
// line, fork chip when childCount ≥ 2). Real rendered cards reach
// 240-260px in worst case. Dagre at 150 was leaving siblings on
// adjacent ranks visually overlapping — user reported this on the
// post-fork canvas where two ChatNodes stacked vertically.
export const NODE_WIDTH = 208;
export const NODE_HEIGHT = 260;
export const RANKSEP = 90;
export const NODESEP = 24;

export interface ChatNodeRFData extends Record<string, unknown> {
  chatNode: ChatNode;
  // Pre-computed previews so the card doesn't repeat work each render.
  userPreview: string;
  assistantPreview: string;
  toolCount: number;
  llmCount: number;
  // Number of disconnected llm_call chains inside this ChatNode's
  // WorkFlow. >1 = harness gap (auto-compact / retry / interruption);
  // surfaces as a 🔗 N chip on the card when >1.
  chainCount: number;
  totalThinkingChars: number;
  isCompactSummary: boolean;
  // True when the ChatNode is a hybrid: real user prompt + an inline
  // compact happened mid-turn (96% of compacts in real CC sessions).
  // Drives a ⊞ marker chip on ChatNodeCard so the user can tell the
  // node's contextTokens dropped because of compaction. Pure compact
  // ChatNodes (no real prompt) keep isCompactSummary chrome instead.
  hasInnerCompact: boolean;
  // Pre-compact context size from compactMetadata.preTokens — surfaced
  // in the inner-compact chip's tooltip so the user sees the magnitude
  // of the drop.
  innerCompactPreTokens: number | null;
  // Session-cumulative trackedFileBackups count at end of this
  // ChatNode. Drives the 📁 N "session 触及文件" chip on
  // ChatNodeCard. The data is CC's INTERNAL `trackedFileBackups`
  // index (Read/Edit/Write touch tracker for backup/undo) — NOT
  // git status. It accumulates monotonically across the session and
  // does NOT shrink after a `git commit`. (Real git workspace dirty
  // is a backlog item — see roadmap "B".) 0 = no snapshots bound
  // (badge hidden). Compare with `nodeOwnFileChangeCount` (✏️)
  // which strips the inherited cumulative set to attribute newly-
  // touched paths to one ChatNode only.
  fileTouchCount: number;
  // v0.8.1 #9 polish: per-node delta = nodeOwnFileChanges
  // (selfSnap \ parentSnap) ∪ tool_use. Drives the ✏️ N stats chip
  // — "本节点新触及文件" — paths first appearing in
  // `trackedFileBackups` at this ChatNode (could be Read / Edit /
  // Write / Bash side-effect; CC's backup tracker doesn't tag the
  // operation kind), unioned with this node's explicit Edit/Write/
  // MultiEdit/NotebookEdit tool_use paths. Strips the cumulative
  // set inherited from ancestors. 0 = badge hidden.
  nodeOwnFileChangeCount: number;
  // v0.8 M5: number of immediate children of this ChatNode in the
  // (possibly merged) ChatFlow. Drives the ⑂ N fork indicator chip
  // on ChatNodeCard — surfaces when ≥2, signals "this is a fork
  // point" without forcing a separate fork-only data path (in-session
  // siblings + cross-session /branch siblings are both just multi-
  // children at this layer).
  childCount: number;
  // v0.11 Git feature: number of git commits detected in this turn
  // (from `meta.commits`). Drives the 📝 N chip on ChatNodeCard; 0 =
  // chip hidden. Click → switch DrillPanel to Git tab.
  commitCount: number;
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
type LayoutAwaySummaryRFNode = RFNode<AwaySummaryNodeData, "awaySummary">;
export type LayoutRFNode =
  | ChatNodeRFNode
  | LayoutChatFoldRFNode
  | LayoutAwaySummaryRFNode;

// Approximate height of a ChatFoldNodeCard. Used as a layout hint;
// dagre also tolerates undersized hints — the actual card auto-grows
// with content. Slightly shorter than NODE_HEIGHT because the fold
// card has less chrome.
const FOLD_NODE_HEIGHT = 92;
// AwaySummaryNodeCard is the smallest synthetic node — just badge +
// truncated summary body.
const AWAY_SUMMARY_NODE_HEIGHT = 80;
// Gap between awaySummary card bottom and host card top. NODE_HEIGHT
// (260) is a DAGRE LAYOUT HINT — actual ChatNodeCard auto-grows with
// content (many tool calls → taller card). Picking a generous gap so
// even a taller-than-hint host doesn't get overlapped by the
// synthetic bottom edge. 64px ≈ one extra row-height beyond hint.
// 中: 留 64px 安全间距。NODE_HEIGHT 只是 dagre hint，真卡可能更高，
// 间距小了易被下方实际卡片遮挡。
const AWAY_GAP_PX = 64;

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

  // EN (2026-05-13): pre-scan for hosts carrying awaySummary content
  // so the dagre setNode pass below can reserve vertical space for
  // their synthetic-card overlay. Without this reservation, fork
  // siblings (same rank in LR = stacked vertically at the same X)
  // get packed tight against host's top edge and the awaySummary
  // card — placed manually after dagre layout at host.y - 274 — ends
  // up rendered on top of the sibling card.
  //
  // 中: 预扫一遍带 awaySummary 的 host id 集合。后面 g.setNode 时给
  // 这些 host 报告"更高"的盒高，把 awaySummary 占的 144px 纵向空间
  // 一并预留——否则 LR 布局下 fork sibling (同 rank 上下堆叠) 会
  // 紧贴 host 上沿，让手动放置的 awaySummary 卡正好压在 sibling 上。
  const awayHostIds = new Set<string>();
  for (const cn of chatFlow.chatNodes) {
    if (projection.hidden.has(cn.id)) continue;
    if (!cn.meta?.awaySummary?.content) continue;
    awayHostIds.add(cn.id);
  }
  // Vertical headroom an awaySummary card needs above its host (its
  // own height + the visual gap). Reserved symmetrically by inflating
  // dagre's host-height hint by 2×: dagre node boxes are
  // centre-anchored, so we have to inflate both up and down to
  // actually push siblings UP. The "wasted" downward 144px just adds
  // air below the host — acceptable cost; the canvas is already
  // mostly empty vertical space.
  // 中: awaySummary 卡需要的纵向 headroom = 卡高 + 间距 = 144px。
  // dagre node box 中心对称，所以盒子加 2×144 = 288 才能让 sibling
  // 真正往上挪 144。下方多出来的 144 是浪费，但 canvas 纵向空旷可接受。
  const AWAY_RESERVED_PX = AWAY_SUMMARY_NODE_HEIGHT + AWAY_GAP_PX;

  // dagre nodes: skip hidden ChatNodes; emit a phantom chatFold for
  // each active fold host BEFORE walking edges so g.setEdge calls find
  // both endpoints registered.
  for (const cn of chatFlow.chatNodes) {
    if (projection.hidden.has(cn.id)) continue;
    const heightHint = awayHostIds.has(cn.id)
      ? NODE_HEIGHT + 2 * AWAY_RESERVED_PX
      : NODE_HEIGHT;
    g.setNode(cn.id, { width: NODE_WIDTH, height: heightHint });
  }
  for (const hostId of projection.activeFoldHostIds) {
    g.setNode(chatFoldIdFor(hostId), {
      width: NODE_WIDTH,
      height: FOLD_NODE_HEIGHT,
    });
  }
  // EN (2026-05-13): synthetic awaySummary nodes are positioned
  // DIRECTLY ABOVE their host ChatNode (Agentloom chatBrief pattern).
  // They're treated as "decorative annotations" — no dagre node, no
  // edge — and placed manually after dagre lays out the real
  // ChatNodes. The fork-sibling overlap that resulted from this
  // pure-overlay strategy is solved by inflating host's dagre height
  // hint (see awayHostIds pass above).
  //
  // Semantic note: the awaySummary lives on the ChatNode that
  // PRECEDED the gap (= "the turn that ended this session and got
  // recapped on resumption"), not the new turn after the gap. So
  // visually the badge appears above the LAST turn of the previous
  // "session segment" — reads as a closing summary for that segment.

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

  // EN (2026-05-13): awaySummary synthetic nodes no longer emit edges
  // — they're stacked above their host as a pure visual annotation
  // (Agentloom chatBrief style). The dashed anchor edge introduced in
  // v1.2 R5 was distracting + competed with the model-tooltip edges
  // for hover focus.
  // 中: 不再为 awaySummary 发边，纯装饰浮在 host 上方。
  for (const hostId of awayHostIds) {
    // Intentionally empty — preserved as placeholder for future
    // per-host annotation hooks (e.g. tooltip warmup).
    void hostId;
  }

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
        chatFlow,
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

  // EN (2026-05-13): synthetic awaySummary RFNodes stacked directly
  // ABOVE the host ChatNode (Agentloom chatBrief style). We look up
  // the host's dagre-laid-out position and offset upward by the
  // synthetic node's height + a small gap. Same X — they share a
  // column with the host.
  //
  // Why outside dagre layout: dagre would treat the synthetic as a
  // proper graph node and either (a) push it to its own rank
  // (creating the upstream-left placement the user disliked) or (b)
  // require us to bend layout to make it overlap a chatNode's column,
  // which dagre doesn't natively support. Manual placement after the
  // fact is cleaner.
  //
  // 中: awaySummary 卡直接放 host 节点正上方，同 X，向上偏移卡高 +
  // gap。不参与 dagre 因为 dagre 会强行给它单独的 rank（= 用户抱怨
  // 的上游左侧位置），手动 offset 干净。
  const awayRfs: LayoutAwaySummaryRFNode[] = [];
  for (const hostId of awayHostIds) {
    const synId = awaySummaryIdFor(hostId);
    const hostPos = g.node(hostId);
    if (!hostPos) continue;
    // hostPos is dagre center coordinates; convert to React Flow
    // top-left then shift the synthetic upward by its height + gap.
    // 中: dagre 的 pos 是中心坐标，转 React Flow 左上角后向上偏移。
    const x = hostPos.x - NODE_WIDTH / 2;
    const y =
      hostPos.y - NODE_HEIGHT / 2 - AWAY_SUMMARY_NODE_HEIGHT - AWAY_GAP_PX;
    const host = chatFlow.chatNodes.find((c) => c.id === hostId);
    const meta = host?.meta?.awaySummary;
    if (!meta) continue;
    awayRfs.push({
      id: synId,
      type: "awaySummary",
      position: { x, y },
      data: {
        hostChatNodeId: hostId,
        content: meta.content,
        timestamp: meta.timestamp,
      },
    });
  }

  return { nodes: [...chatNodeRfs, ...foldRfs, ...awayRfs], edges };
}

// Re-export so consumers (tests, future tooling) can introspect the
// projection alongside layout output without re-importing the helper.
export type { FoldProjection };

// Model→context-window mapping moved to src/data/modelContext.ts so
// the parser (server side) can read it without crossing the canvas
// boundary. Re-exported here for tests / external consumers that
// already imported from this module.
import {
  MODEL_CONTEXT_WINDOW,
  maxContextForModel,
} from "@/data/modelContext";
export { MODEL_CONTEXT_WINDOW, maxContextForModel };
const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;

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
//
// v0.10 lazy ChatFlow B3: prefer workflow.summary.lastModel (server-
// computed once at parse time); fall back to walking workflow.nodes
// when summary is absent (test fixtures, hand-built flows). Keeping
// the fallback means tests don't all need to construct summaries.
function lastModelOf(cn: ChatNode): string | undefined {
  if (cn.workflow.summary) return cn.workflow.summary.lastModel;
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
  // v0.10 lazy ChatFlow B3: prefer summary; fall back to walking
  // workflow.nodes when summary absent (tests).
  if (cn.workflow.summary) {
    return {
      contextTokens: cn.workflow.summary.contextTokens,
      maxContextTokens: cn.workflow.summary.maxContextTokens,
    };
  }
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
  chatFlow: ChatFlow,
): ChatNodeRFData {
  const { contextTokens, maxContextTokens } = deriveContextTokens(cn);
  // v0.10 lazy ChatFlow B3: counts come from the server-computed
  // summary so the canvas card never depends on workflow.nodes
  // having loaded. ``s`` shorthand for the summary path; fall back
  // to deriving from nodes for test fixtures without summary.
  const s = cn.workflow.summary;
  return {
    chatNode: cn,
    userPreview: previewUserContent(cn.userMessage.content),
    assistantPreview: lastAssistantPreview(cn),
    toolCount:
      s?.toolCount ??
      cn.workflow.nodes.filter(
        (n) => n.kind === "tool_call" || n.kind === "delegate",
      ).length,
    llmCount:
      s?.llmCount ??
      cn.workflow.nodes.filter((n) => n.kind === "llm_call").length,
    // Fall back to llmCount when summary missing (test fixtures): an
    // unanalysed workflow conservatively reads as "1 chain" since
    // we can't compute the disjoint-chain check without summary.
    chainCount:
      s?.chainCount ??
      (cn.workflow.nodes.some((n) => n.kind === "llm_call") ? 1 : 0),
    totalThinkingChars:
      s?.totalThinkingChars ??
      cn.workflow.nodes.reduce((acc, n) => {
        if (n.kind !== "llm_call") return acc;
        return acc + n.thinking.reduce((a, t) => a + (t.text?.length ?? 0), 0);
      }, 0),
    isCompactSummary: cn.isCompactSummary,
    hasInnerCompact: cn.hasInnerCompact ?? false,
    innerCompactPreTokens: cn.compactMetadata?.preTokens ?? null,
    fileTouchCount: distinctTouchedFiles(cn).size,
    nodeOwnFileChangeCount: nodeOwnFileChanges(cn, chatFlow).size,
    childCount,
    commitCount: cn.meta.commits?.length ?? 0,
    contextTokens,
    maxContextTokens,
    slashCommand: cn.slashCommand,
    hasIncomingEdge: edges.hasIncomingEdge,
    hasOutgoingEdge: edges.hasOutgoingEdge,
  };
}

// Latest-snapshot trackedFileBackups path set for this ChatNode —
// the "session 触及文件" cumulative index at the end of this turn.
//
// Earlier (v0.7 → v0.11 first attempt) the comment claimed this was
// "git working-tree dirty since last commit". That is FALSE — the
// underlying CC field is `snapshot.trackedFileBackups`, an internal
// per-file-version backup index used by CC for Read/Edit/Write
// rollback. It accumulates across the session, includes Read'd
// files, and does NOT shrink after a `git commit`. The chip's
// semantic is therefore "files CC has touched in this session up to
// the end of this turn", not "git workspace state".
//
// We keep "latest snapshot only" because the index accumulates
// monotonically — last frame supersets every earlier frame in the
// same ChatNode. Snapshots are stored in JSONL ingestion order
// (chronological); both isUpdate=true/false count.
// Empty array → empty set (chip hidden).
//
// Future: a true "git workspace dirty" view (roadmap B) would
// require running `git status --porcelain` in the session's cwd
// from the server, separate data path.
export function distinctTouchedFiles(cn: ChatNode): Set<string> {
  const snaps = cn.meta.fileHistorySnapshots ?? [];
  if (snaps.length === 0) return new Set();
  return new Set(snaps[snaps.length - 1].trackedFiles);
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
  // v0.10 lazy ChatFlow B3: prefer summary.toolUseFilePaths
  // (server-computed at parse time, ships in lite ChatFlow). Falls
  // back to walking workflow.nodes when summary absent (test fixtures
  // built without the parser). Both branches return the same value
  // for normal session loads.
  if (cn.workflow.summary) {
    for (const p of cn.workflow.summary.toolUseFilePaths) out.add(p);
    return out;
  }
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
// fileHistorySnapshots; return that ancestor's *latest* snapshot
// trackedFileBackups path set. Empty set when no such ancestor
// exists. Bounded by chatFlow size (cycles are guarded but shouldn't
// occur in well-formed flows). Mirrors `distinctTouchedFiles` —
// latest frame supersets earlier ones in the same ChatNode, so taking
// the last is sufficient + cheaper than unioning.
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
      return new Set(snaps[snaps.length - 1].trackedFiles);
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
  // v0.10 lazy ChatFlow B3: prefer summary.assistantPreview
  // (server-computed once, ships in lite ChatFlow). The truncation
  // length is identical (80 chars) on both sides.
  if (cn.workflow.summary) return cn.workflow.summary.assistantPreview;
  const llms = cn.workflow.nodes.filter((n) => n.kind === "llm_call");
  if (llms.length === 0) return "";
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
