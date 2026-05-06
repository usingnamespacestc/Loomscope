// Map a ChatNode's WorkFlow (llm_call / tool_call / delegate / compact /
// attachment WorkNodes) onto React Flow nodes/edges with dagre LR
// positions — the drill-down view that backs ``WorkFlowCanvas``.
//
// Mirrors ``layoutDag.ts`` (ChatFlow layer) intentionally so the two
// canvases share visual DNA: dagre LR, parent → child via ``parentUuid``,
// neutral continuation edges. Edge kinds split into ``continuation``
// (assistant → tool_result → next assistant) and ``spawn`` (assistant
// → tool_use block → tool_call / delegate child) per
// ``design-visual-language.md``.
//
// ── Node sizing rationale ──
// Different WorkNode kinds hold different amounts of content; dagre needs
// approximate widths/heights to lay things out without overlap. We pin
// widths per-kind based on the chrome each card displays — measured from
// the actual rendered cards in dev (not eyeballed). Heights are layout
// hints; React Flow grows the rendered card to fit content.

import dagre from "@dagrejs/dagre";
import type { Edge as RFEdge, Node as RFNode } from "@xyflow/react";

import type {
  AttachmentNode,
  ChatNode,
  CompactNode,
  DelegateNode,
  LlmCallNode,
  ToolCallNode,
  WorkNode,
} from "@/data/types";

// Per-kind sizing — width drives the card's max-w; height is the
// dagre hint. React Flow auto-grows the rendered card, but dagre uses
// the hint to pick positions, so an undersized hint makes neighbours
// overlap visually (the original v0.x bug user reproed: TaskCreate
// tool_call with multi-line `input` rendered ~200-250px tall while
// the hint stayed at 125 → vertical-stack neighbours overlapped).
//
// `WF_NODE_SIZE` keeps the BASE (chrome only) sizes; the per-node
// `estimateWfNodeHeight` function below adds an estimate based on
// the WorkNode's actual content (input bytes, text length, thinking
// blocks, etc.) so dagre lays out tall cards with breathing room
// without overspacing short ones.
//
// 中: WF_NODE_SIZE 是仅含 chrome 的"基线"尺寸；estimateWfNodeHeight
// 按节点实际内容（input / text / thinking）追加估算高度，让 dagre 布
// 局贴近真实卡片尺寸。原 bug：tool_call 固定 125 让 TaskCreate 这种
// 多行 input 的卡片相邻 sibling 视觉重叠。
export const WF_NODE_SIZE: Record<WorkNode["kind"], { width: number; height: number }> = {
  llm_call: { width: 240, height: 140 },
  tool_call: { width: 240, height: 125 },
  delegate: { width: 280, height: 200 },
  compact: { width: 240, height: 130 },
  attachment: { width: 200, height: 95 },
};

export const WF_RANKSEP = 64;
// nodesep raised 16 → 28 — even with content-size hints, leaf
// tool_call / attachment cards visually crowded under 16 px gaps.
export const WF_NODESEP = 28;

// Tunables for the height estimator. ~16 px per visual line is the
// observed average across the WorkNode card chrome (font 11-12 px +
// line-height + small per-section padding).
const HEIGHT_PER_LINE = 16;
// Hard cap so a 10 KB tool_input doesn't blow layout sky-high.
// Above this height we let the card scroll internally and accept the
// visual overlap risk for those (rare) extreme cases.
const HEIGHT_CAP = 360;
// Approximate chars per visible line in the card's content area
// (240 px ~ 36 chars at 11 px monospace; round down for safety).
const CHARS_PER_LINE = 32;

function approxLines(text: string): number {
  if (!text) return 0;
  // Count explicit newlines + estimate wrapped lines for each segment.
  const segments = text.split(/\r?\n/);
  let n = 0;
  for (const seg of segments) {
    n += Math.max(1, Math.ceil(seg.length / CHARS_PER_LINE));
  }
  return n;
}

/**
 * Per-WorkNode height estimate for dagre. Returns the BASE chrome
 * height + an estimate of content-driven height, capped at
 * HEIGHT_CAP. Pure function — given the same WorkNode produces the
 * same number, so layout is deterministic across renders.
 */
export function estimateWfNodeHeight(n: WorkNode): number {
  const base = WF_NODE_SIZE[n.kind].height;
  let extra = 0;
  if (n.kind === "tool_call") {
    // Cards display the input as JSON-ish lines + a result preview
    // line. The input is the primary driver of height variation
    // (TaskCreate / Edit / Write all carry multi-line strings).
    const inputJson = n.input ? JSON.stringify(n.input) : "";
    extra += Math.min(approxLines(inputJson), 12) * HEIGHT_PER_LINE;
    // Result preview adds another 1-2 lines on top of the chrome.
  } else if (n.kind === "delegate") {
    // description + prompt + result content all show in the card.
    const desc = n.description ?? "";
    const prompt = n.prompt ?? "";
    const content = n.content ?? "";
    extra +=
      Math.min(approxLines(desc) + approxLines(prompt) + approxLines(content), 16) *
      HEIGHT_PER_LINE;
  } else if (n.kind === "llm_call") {
    // text + thinking. Cards usually preview-truncate so growth is
    // bounded, but multi-thinking-block streams can be tall.
    const textLines = approxLines(n.text ?? "");
    let thinkingLines = 0;
    for (const t of n.thinking) {
      if (t.text) thinkingLines += approxLines(t.text);
    }
    extra += Math.min(textLines + thinkingLines, 14) * HEIGHT_PER_LINE;
  } else if (n.kind === "compact") {
    extra += Math.min(approxLines(n.summaryText ?? ""), 6) * HEIGHT_PER_LINE;
  }
  // attachment: fixed-shape chrome, no content estimate needed.
  return Math.min(base + extra, HEIGHT_CAP);
}

// Per-kind RFData shape — narrowed via WorkNode subtype generics so each
// card component can rely on the discriminated workNode type without
// runtime kind checks. Single union type lets ``WorkFlowCanvas`` use
// one ``nodeTypes`` map without per-kind generics on the canvas itself.
export interface WorkNodeRFData<N extends WorkNode = WorkNode>
  extends Record<string, unknown> {
  workNode: N;
  hasIncomingEdge: boolean;
  hasOutgoingEdge: boolean;
}

// Per-kind RFNode aliases. Card components type their NodeProps against
// the matching alias so xyflow's ``NodeProps`` generic constraint
// (``extends Node<...>``) is satisfied — passing the raw data shape
// fails the constraint because Node also requires id / position / data.
export type LlmCallRFNode = RFNode<WorkNodeRFData<LlmCallNode>, "llm_call">;
export type ToolCallRFNode = RFNode<WorkNodeRFData<ToolCallNode>, "tool_call">;
export type DelegateRFNode = RFNode<WorkNodeRFData<DelegateNode>, "delegate">;
export type CompactRFNode = RFNode<WorkNodeRFData<CompactNode>, "compact">;
export type AttachmentRFNode = RFNode<WorkNodeRFData<AttachmentNode>, "attachment">;
export type WorkNodeRFNode =
  | LlmCallRFNode
  | ToolCallRFNode
  | DelegateRFNode
  | CompactRFNode
  | AttachmentRFNode;

export interface LayoutWorkFlowResult {
  nodes: WorkNodeRFNode[];
  edges: RFEdge[];
}

// Find the WorkNode whose uuid this child's ``parentUuid`` lands on.
// ``parentUuid`` for tool_call / delegate is the *assistant record uuid*
// (= the llm_call's id). For a follow-up llm_call after a tool_result,
// ``parentUuid`` is the *user record uuid* — that user record is the one
// carrying ``tool_use_id`` that points back to the prior tool_call. We
// resolve user-record parents via the per-tool-call ``resultUserUuid``
// reverse map so the edge lands on the tool_call (not on a missing
// node).
function buildParentResolver(
  nodes: WorkNode[],
): (parentUuid: string | null) => string | null {
  const byNodeId = new Set<string>();
  // ``resultUserUuid`` → owning tool_call / delegate id, so a follow-up
  // llm_call whose parent is a user record routes back through the
  // tool/delegate that produced the result.
  const userUuidToToolNodeId = new Map<string, string>();
  for (const n of nodes) {
    byNodeId.add(n.id);
    if (n.kind === "tool_call" || n.kind === "delegate") {
      if (n.resultUserUuid) userUuidToToolNodeId.set(n.resultUserUuid, n.id);
    }
  }
  return (parentUuid) => {
    if (!parentUuid) return null;
    if (byNodeId.has(parentUuid)) return parentUuid;
    const viaUser = userUuidToToolNodeId.get(parentUuid);
    return viaUser ?? null;
  };
}

export function layoutWorkFlow(chatNode: ChatNode): LayoutWorkFlowResult {
  const wf = chatNode.workflow;
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: "LR",
    nodesep: WF_NODESEP,
    ranksep: WF_RANKSEP,
    marginx: 20,
    marginy: 20,
  });

  // Stash per-node height for the layout-output mapping below.
  const nodeHeights = new Map<string, number>();
  for (const n of wf.nodes) {
    const width = WF_NODE_SIZE[n.kind].width;
    const height = estimateWfNodeHeight(n);
    nodeHeights.set(n.id, height);
    g.setNode(n.id, { width, height });
  }

  const resolveParent = buildParentResolver(wf.nodes);

  // Build edges from ``parentUuid``. ``spawn`` (orange triangle) when
  // parent is an llm_call and child is a tool_call/delegate — the
  // tool was emitted by that LLM turn. Otherwise ``continuation`` (gray).
  //
  // PR 2.1 step 4: tool-fan-in for continuation edges. CC's parentUuid
  // chain only records the LAST tool_result of a multi-tool round, so
  // a naive parentUuid walk would produce a single t_last → l_next
  // edge. But the next API call sees ALL tool_results from that round
  // as input — so the canonical information-flow visualisation is
  // {t_1, t_2, ..., t_n} → l_next. When a continuation edge would
  // resolve through a tool_call/delegate parent, we emit additional
  // edges from every sibling tool/delegate that shares the same
  // upstream llm_call. Visual + structural intent: a wide fan-in
  // arrow pattern reflects the actual prompt assembly.
  const edges: RFEdge[] = [];
  const incoming = new Set<string>();
  const outgoing = new Set<string>();
  const byId = new Map(wf.nodes.map((n) => [n.id, n] as const));
  const addEdge = (
    sourceId: string,
    targetId: string,
    kind: "spawn" | "continuation",
  ) => {
    const id = `we-${sourceId}->${targetId}`;
    if (edges.some((e) => e.id === id)) return; // dedupe in case fan-in
    g.setEdge(sourceId, targetId);
    edges.push({ id, source: sourceId, target: targetId, type: kind });
    incoming.add(targetId);
    outgoing.add(sourceId);
  };
  for (const child of wf.nodes) {
    const parentId = resolveParent(child.parentUuid);
    if (!parentId) continue;
    const parent = byId.get(parentId);
    if (!parent) continue;
    if (
      parent.kind === "llm_call" &&
      (child.kind === "tool_call" || child.kind === "delegate")
    ) {
      // spawn: l → t
      addEdge(parentId, child.id, "spawn");
      continue;
    }
    if (
      child.kind === "llm_call" &&
      (parent.kind === "tool_call" || parent.kind === "delegate")
    ) {
      // continuation through a tool_result. Fan in from every sibling
      // tool/delegate that shares the same upstream llm_call.
      const upstreamLlmId = parent.parentUuid;
      const siblings = wf.nodes.filter(
        (n) =>
          (n.kind === "tool_call" || n.kind === "delegate") &&
          n.parentUuid === upstreamLlmId,
      );
      // siblings always includes ``parent`` itself; emit at least that
      // edge even if siblings list is empty (defensive).
      const sources = siblings.length > 0 ? siblings : [parent];
      for (const sib of sources) {
        addEdge(sib.id, child.id, "continuation");
      }
      continue;
    }
    // Other continuation cases (e.g. llm → llm direct, attachment chains).
    addEdge(parentId, child.id, "continuation");
  }

  dagre.layout(g);

  const nodes: WorkNodeRFNode[] = wf.nodes.map((n) => {
    const pos = g.node(n.id);
    const width = WF_NODE_SIZE[n.kind].width;
    // Use the SAME height we fed dagre — `pos` from dagre is the
    // node's center; converting to top-left for React Flow needs
    // half the height we used for layout, not the BASE height (that
    // would re-introduce a position vs spacing inconsistency).
    const height = nodeHeights.get(n.id) ?? WF_NODE_SIZE[n.kind].height;
    const x = (pos?.x ?? 0) - width / 2;
    const y = (pos?.y ?? 0) - height / 2;
    // ReactFlow ``type`` is the WorkNode kind — drives the per-kind
    // card component lookup in WorkFlowCanvas's ``nodeTypes`` map.
    // The cast narrows to the discriminated alias matching n.kind.
    return {
      id: n.id,
      type: n.kind,
      position: { x, y },
      data: {
        workNode: n,
        hasIncomingEdge: incoming.has(n.id),
        hasOutgoingEdge: outgoing.has(n.id),
      },
    } as WorkNodeRFNode;
  });

  return { nodes, edges };
}

// ── Per-kind preview helpers (used by card components) ────────────────

const PREVIEW_LEN = 120;

export function previewLlmCallText(n: LlmCallNode): string {
  const t = (n.text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length <= PREVIEW_LEN ? t : t.slice(0, PREVIEW_LEN - 1) + "…";
}

export function llmCallThinkingLines(n: LlmCallNode): number {
  let lines = 0;
  for (const t of n.thinking) {
    if (!t.text) continue;
    lines += t.text.split(/\r?\n/).length;
  }
  return lines;
}

export function previewToolInput(n: ToolCallNode): string[] {
  // Render ``key: value`` lines for the top-level fields of the
  // tool input. Long values get truncated. Returns up to 3 lines so
  // the card stays compact; drill panel (v0.4) shows full args.
  const out: string[] = [];
  if (!n.input || typeof n.input !== "object") return out;
  const obj = n.input as Record<string, unknown>;
  for (const k of Object.keys(obj).slice(0, 3)) {
    const raw = obj[k];
    let v: string;
    if (typeof raw === "string") v = raw;
    else if (raw == null) v = String(raw);
    else v = JSON.stringify(raw);
    v = v.replace(/\s+/g, " ").trim();
    if (v.length > 80) v = v.slice(0, 79) + "…";
    out.push(`${k}: ${v}`);
  }
  return out;
}

export function previewToolResult(n: ToolCallNode): string {
  // First non-empty line of the tool_result content. The block is the
  // canonical form (``message.content[*].tool_result``); the
  // record-level ``toolUseResult`` is multi-shape so we keep it for
  // drill panel rendering only.
  const block = n.resultBlock as
    | { content?: unknown }
    | undefined;
  let content: unknown = block?.content;
  if (typeof content === "string") {
    const first = content.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
    return truncate(first.trim(), PREVIEW_LEN);
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as { type?: string; text?: unknown };
        if (b.type === "text" && typeof b.text === "string") {
          const first =
            b.text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
          return truncate(first.trim(), PREVIEW_LEN);
        }
      }
    }
  }
  return "";
}

export function delegateContentPreview(n: DelegateNode): string {
  const c = (n.content ?? "").replace(/\s+/g, " ").trim();
  return truncate(c, PREVIEW_LEN);
}

// Compact preview — render the first non-empty line of the summary
// text so the user gets a hint of what was compressed.
export function compactSummaryPreview(n: CompactNode): string {
  const t = (n.summaryText ?? "").trim();
  if (!t) return "";
  const first = t.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  return truncate(first.trim(), PREVIEW_LEN);
}

export function attachmentLabel(n: AttachmentNode): string {
  const raw = n.raw as Record<string, unknown> | undefined;
  const att = (raw?.attachment as Record<string, unknown> | undefined) ?? raw ?? {};
  // file / compact_file_reference: prefer filename
  const filename = typeof att.filename === "string" ? att.filename : null;
  if (filename) return truncate(filename, 60);
  // queued_command: prefer prompt
  const prompt = typeof att.prompt === "string" ? att.prompt : null;
  if (prompt) return truncate(prompt.replace(/\s+/g, " ").trim(), 60);
  return n.attachmentType;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
