// Drill-panel content when WorkFlow is the active view: shows the
// selected WorkNode's full payload, branched per kind. Five kinds:
// llm_call / tool_call / delegate / compact / attachment — each
// renders the spec'd fields from design-visual-language.md drill panel
// table.
//
// Tool result overflow loading (>200KB tool-results/<refId>.txt files)
// is wired through ``useToolResultChunks`` — chunked, scroll-driven.
// Edit / MultiEdit / Write tool_calls auto-render as DiffView when
// their toolUseResult carries a structuredPatch (CC source: utils/diff.ts).

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { JsonView } from "@/components/JsonView";
import { MarkdownView } from "@/components/MarkdownView";
import { DiffView, extractStructuredPatch } from "@/components/DiffView";
import { useToolResultChunks } from "@/components/drill/useToolResultChunks";
import { useWorkFlowPanShim } from "@/canvas/WorkFlowPanContext";
import { useStore } from "@/store/index";
import type {
  AttachmentNode,
  CompactNode,
  DelegateNode,
  LlmCallNode,
  ToolCallNode,
  WorkNode,
} from "@/data/types";

interface Props {
  workNode: WorkNode;
  sessionId: string;
  // PR 2: sibling WorkNodes in the same WorkFlow. LlmCallDetail uses
  // this to surface (a) spawned tool_calls (children with parentUuid
  // pointing at this llm_call) and (b) chain-internal accumulation
  // (walk parentUuid back to the chain root). Tool/Delegate/Compact/
  // Attachment kinds don't currently consume it but accept the prop
  // for symmetry; future drill-context features can opt in.
  workflowNodes?: WorkNode[];
}

// Memo wrapper — selection switches reuse the same WorkNode object
// reference from the parsed ChatFlow, so identity comparison is
// sufficient. Skips the markdown / JsonView re-render on unrelated
// store updates (e.g. drill-panel-width drag). workflowNodes is the
// same array identity across selection changes (DetailTabContent
// memos it from drilledWorkflowNodes).
export const WorkNodeDetail = memo(
  WorkNodeDetailImpl,
  (a, b) =>
    a.workNode === b.workNode &&
    a.sessionId === b.sessionId &&
    a.workflowNodes === b.workflowNodes,
);

function WorkNodeDetailImpl({ workNode, sessionId, workflowNodes }: Props) {
  return (
    <div data-testid="work-node-detail" className="flex flex-col gap-3">
      <header className="space-y-1">
        <div className="text-[10px] uppercase tracking-wide text-gray-500">
          WorkNode · {workNode.kind}
        </div>
        <div className="font-mono text-[11px] text-gray-700 break-all">
          {workNode.id}
        </div>
        {workNode.timestamp && (
          <div className="font-mono text-[10px] text-gray-400">
            {workNode.timestamp}
          </div>
        )}
      </header>
      {workNode.kind === "llm_call" && (
        <LlmCallDetail
          node={workNode}
          sessionId={sessionId}
          workflowNodes={workflowNodes ?? []}
        />
      )}
      {workNode.kind === "tool_call" && (
        <ToolCallDetail node={workNode} sessionId={sessionId} />
      )}
      {workNode.kind === "delegate" && (
        <DelegateDetail node={workNode} sessionId={sessionId} />
      )}
      {workNode.kind === "compact" && <CompactDetail node={workNode} />}
      {workNode.kind === "attachment" && <AttachmentDetail node={workNode} />}
    </div>
  );
}

function Section({
  title,
  children,
  testId,
}: {
  title: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <section data-testid={testId}>
      <h3 className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">
        {title}
      </h3>
      <div className="rounded border border-gray-200 bg-white p-2.5">{children}</div>
    </section>
  );
}

// ── llm_call ──────────────────────────────────────────────────────────

function LlmCallDetail({
  node,
  sessionId,
  workflowNodes,
}: {
  node: LlmCallNode;
  sessionId: string;
  workflowNodes: WorkNode[];
}) {
  const { t } = useTranslation();
  const setTab = useStore((s) => s.setDrillPanelTab);
  const setWorkflowSelected = useStore((s) => s.setWorkflowSelected);
  const panToWorkNode = useWorkFlowPanShim();

  // PR 2-B: spawned tool_uses = sibling tool_call/delegate nodes whose
  // parentUuid === this llm_call's id (the assistant record uuid).
  const spawnedTools = useMemo(
    () =>
      workflowNodes.filter(
        (n) =>
          (n.kind === "tool_call" || n.kind === "delegate") &&
          n.parentUuid === node.id,
      ),
    [workflowNodes, node.id],
  );

  // PR 2-C: chain-internal predecessors. Walk parentUuid back from
  // ``node`` until we leave this WorkFlow (parentUuid resolves to a
  // node that's not in workflowNodes — that's the chain root). Each
  // hop crosses one of two edge types:
  //   - llm_N.parentUuid === tool_M.resultUserUuid  → continuation
  //     edge. Land on tool_M.
  //   - tool_M.parentUuid === llm_(M-1).id           → spawn edge.
  //     Land on llm_(M-1).
  // Walk yields a list of WorkNodes [most-recent, ..., chain-root]
  // EXCLUDING ``node`` itself.
  const chainHistory = useMemo(
    () => walkChainBackward(node, workflowNodes),
    [node, workflowNodes],
  );
  const chainLlmCount = chainHistory.filter((n) => n.kind === "llm_call").length;
  const chainToolCount = chainHistory.filter(
    (n) => n.kind === "tool_call" || n.kind === "delegate",
  ).length;

  // PR 2.2: chain_position metadata. When this llm_call is a chain
  // root (its parentUuid doesn't resolve inside this WorkFlow) AND
  // there's an earlier llm_call in document order that belongs to a
  // different chain, surface the previous chain's tail as a clickable
  // jump target + a best-effort break reason. Pure UI metadata — does
  // not represent anything in the API request payload.
  const chainPosition = useMemo(
    () => computeChainPosition(node, workflowNodes),
    [node, workflowNodes],
  );

  const onPanelView = useCallback(
    (id: string) => setWorkflowSelected(sessionId, id),
    [setWorkflowSelected, sessionId],
  );
  const onCanvasLocate = useCallback(
    (id: string) => {
      setWorkflowSelected(sessionId, id);
      panToWorkNode(id);
    },
    [setWorkflowSelected, sessionId, panToWorkNode],
  );

  return (
    <>
      <Section title="Model / Request">
        <ul className="text-[11px] text-gray-700 font-mono space-y-0.5">
          <li>model: {node.model ?? "—"}</li>
          {node.requestId && <li>requestId: {node.requestId}</li>}
          {node.stopReason && <li>stop_reason: {node.stopReason}</li>}
          {node.parentUuid && <li>parentUuid: {node.parentUuid}</li>}
        </ul>
        {chainPosition && (
          <ChainPositionRow
            position={chainPosition}
            onPanelView={onPanelView}
            onCanvasLocate={onCanvasLocate}
          />
        )}
      </Section>

      <Section title="Input · 上下文">
        <button
          type="button"
          onClick={() => setTab("conversation")}
          className="inline-flex w-full items-center justify-between gap-2 rounded border border-blue-200 bg-blue-50 px-2 py-1.5 text-[11px] text-blue-800 hover:border-blue-400 hover:bg-blue-100 transition-colors"
          data-testid="llm-input-jump-conversation"
        >
          <span>📜 Conversation 截止此节点（点击切到 Conversation 面板）</span>
          <span className="font-mono text-[10px] opacity-70">→</span>
        </button>
        {chainHistory.length > 0 && (
          <div className="mt-1.5">
            <ChainHistoryToggle
              history={chainHistory}
              llmCount={chainLlmCount}
              toolCount={chainToolCount}
              onPanelView={onPanelView}
              onCanvasLocate={onCanvasLocate}
            />
          </div>
        )}
        <p
          className="mt-1.5 text-[10px] leading-relaxed text-gray-400"
          data-testid="llm-input-system-note"
        >
          注：CC 实际发给 API 的 input 还包括 system prompt + 启用工具集，
          这两部分在 CC 启动时由 base prompt + CLAUDE.md + settings + tool
          registry 拼接，不写入 jsonl，所以这里无法呈现。
        </p>
      </Section>

      <Section title="Output · Text">
        {node.text ? (
          <MarkdownView className="prose prose-sm max-w-none text-[12px] text-gray-900">
            {node.text}
          </MarkdownView>
        ) : (
          <div className="text-[11px] italic text-gray-400">{t("placeholders.empty")}</div>
        )}
      </Section>

      {node.thinking.length > 0 && (
        <Section
          title={`Output · Thinking (${node.thinking.length} block${node.thinking.length === 1 ? "" : "s"})`}
        >
          <div className="space-y-1.5">
            {node.thinking.map((t, i) => (
              <div
                key={i}
                className="rounded border-l-2 border-blue-200 bg-blue-50/40 px-2 py-1 text-[11px] text-gray-700 whitespace-pre-wrap"
              >
                {t.text}
              </div>
            ))}
          </div>
        </Section>
      )}

      {spawnedTools.length > 0 && (
        <Section
          title={`Output · 触发的工具调用 (${spawnedTools.length})`}
          testId="llm-spawned-tools"
        >
          <ul className="space-y-1.5">
            {spawnedTools.map((t) => (
              <NodeNavRow
                key={t.id}
                node={t}
                onPanelView={onPanelView}
                onCanvasLocate={onCanvasLocate}
                testIdPrefix="llm-spawned-tool"
              />
            ))}
          </ul>
        </Section>
      )}

      {node.usage && (
        <Section title="Usage" testId="llm-usage">
          <UsageBlock node={node} chainHistory={chainHistory} />
        </Section>
      )}

      {node.errors && node.errors.length > 0 && (
        <Section title="Errors">
          <ul className="text-[11px] text-rose-700 space-y-0.5">
            {node.errors.map((e, i) => (
              <li key={i}>
                <span className="font-mono">{e.type}</span>
                {e.message ? `: ${e.message}` : ""}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

// PR 2-B/C: shared row for "navigate to a sibling WorkNode" lists.
// Two buttons per entry implementing the dual-track decision: panel-
// only (selects the node, right panel updates, canvas position
// unchanged) vs canvas-locate (selects + pans the canvas, useful
// when the user wants to see the node in its DAG context).
function NodeNavRow({
  node,
  onPanelView,
  onCanvasLocate,
  testIdPrefix,
}: {
  node: WorkNode;
  onPanelView: (id: string) => void;
  onCanvasLocate: (id: string) => void;
  testIdPrefix: string;
}) {
  const { t } = useTranslation();
  const label = describeNodeForNav(node, t("placeholders.empty_turn"));
  return (
    <li
      className="flex items-center justify-between gap-2 rounded border border-gray-200 bg-gray-50 px-2 py-1"
      data-testid={`${testIdPrefix}-row-${node.id}`}
    >
      <span className="min-w-0 flex-1 truncate text-[11px] text-gray-700">
        <span className="font-mono text-[10px] text-gray-400 mr-1.5">
          {node.kind}
        </span>
        {label}
      </span>
      <span className="flex shrink-0 gap-1">
        <button
          type="button"
          onClick={() => onPanelView(node.id)}
          className="rounded border border-gray-300 bg-white px-1.5 py-0.5 text-[10px] text-gray-700 hover:border-blue-400 hover:bg-blue-50 transition-colors"
          title="在右面板查看（不移动画布）"
          data-testid={`${testIdPrefix}-panel-${node.id}`}
        >
          📋 面板
        </button>
        <button
          type="button"
          onClick={() => onCanvasLocate(node.id)}
          className="rounded border border-gray-300 bg-white px-1.5 py-0.5 text-[10px] text-gray-700 hover:border-purple-400 hover:bg-purple-50 transition-colors"
          title="在画布定位 + 选中"
          data-testid={`${testIdPrefix}-canvas-${node.id}`}
        >
          🎯 画布
        </button>
      </span>
    </li>
  );
}

function describeNodeForNav(n: WorkNode, emptyTurnLabel = "(empty turn)"): string {
  if (n.kind === "llm_call") {
    const text = n.text?.slice(0, 60) || (n.thinking[0]?.text?.slice(0, 60) ?? "");
    return text || `${n.id.slice(0, 8)} ${emptyTurnLabel}`;
  }
  if (n.kind === "tool_call") {
    const inputStr = n.input ? JSON.stringify(n.input).slice(0, 60) : "";
    return `${n.toolName}${inputStr ? `: ${inputStr}` : ""}`;
  }
  if (n.kind === "delegate") {
    return `${n.toolName}${n.description ? `: ${n.description.slice(0, 60)}` : ""}`;
  }
  if (n.kind === "compact") return `compact (${n.summaryText.slice(0, 60)})`;
  return n.id.slice(0, 8);
}

// PR 2.3: usage block summarising the call's token cost + a delta
// row showing how much *more* context this llm_call sent compared to
// the previous llm_call in the chain. Why useful: `usage.input_tokens`
// is cumulative (CC sends the entire messages array each call), so
// the on-card TokenBar shows monotonically-rising context fill across
// the chain. The per-node "what did THIS turn add" answer requires
// the delta — surfaced here so users can answer "did this round
// pile in 30k tokens of tool_results, or just a small thinking?".
function UsageBlock({
  node,
  chainHistory,
}: {
  node: LlmCallNode;
  chainHistory: WorkNode[];
}) {
  const ctxTokens = computeCtxTokens(node.usage);
  const outputTokens = numericField(node.usage, "output_tokens");
  // Find most recent llm_call predecessor in chain (chainHistory is
  // ordered most-recent-first per walkChainBackward's contract).
  const prevLlm = chainHistory.find((n) => n.kind === "llm_call");
  const prevCtx = prevLlm
    ? computeCtxTokens((prevLlm as LlmCallNode).usage)
    : null;
  const delta = prevCtx != null ? ctxTokens - prevCtx : null;
  return (
    <div className="space-y-2">
      <ul className="text-[11px] text-gray-700 font-mono space-y-0.5">
        <li>
          ctx (input + cache): <strong>{formatTokens(ctxTokens)}</strong>
          <span className="text-gray-400"> · 这是 CC 此次 API call 送给 Anthropic 的总 input</span>
        </li>
        <li>output: {formatTokens(outputTokens)}</li>
        {delta != null && (
          <li data-testid="llm-usage-delta">
            delta vs 链内上一节点:{" "}
            <strong className={delta >= 0 ? "text-amber-700" : "text-emerald-700"}>
              {delta >= 0 ? "+" : ""}
              {formatTokens(delta)}
            </strong>
            <span className="text-gray-400"> · 本节点新增上下文体量</span>
          </li>
        )}
      </ul>
      <details className="text-[10px]">
        <summary className="cursor-pointer text-gray-500 hover:text-gray-700">
          查看完整 usage 字段
        </summary>
        <div className="mt-1.5">
          <JsonView value={node.usage} />
        </div>
      </details>
    </div>
  );
}

function computeCtxTokens(usage: Record<string, unknown> | undefined): number {
  return (
    numericField(usage, "input_tokens") +
    numericField(usage, "cache_read_input_tokens") +
    numericField(usage, "cache_creation_input_tokens")
  );
}

function numericField(
  usage: Record<string, unknown> | undefined,
  key: string,
): number {
  if (!usage) return 0;
  const v = usage[key];
  return typeof v === "number" ? v : 0;
}

function formatTokens(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}k`;
  return `${sign}${abs}`;
}

// PR 2.1: chain-internal accumulation toggle. Renders inline inside
// the input Section (PR 2.1 step 2 corrected the placement: the chain
// history IS part of the LLM's input, not its output, since CC's
// API request includes the prior thinking/tool_use/tool_result from
// the same chain). Default-folded so the heavy content doesn't push
// the rest of the panel below the fold.
function ChainHistoryToggle({
  history,
  llmCount,
  toolCount,
  onPanelView,
  onCanvasLocate,
}: {
  history: WorkNode[];
  llmCount: number;
  toolCount: number;
  onPanelView: (id: string) => void;
  onCanvasLocate: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="llm-chain-history">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded border border-gray-200 bg-gray-50 px-2 py-1 text-[10px] uppercase tracking-wide text-gray-600 hover:border-gray-400 hover:bg-gray-100 transition-colors"
        data-testid="llm-chain-history-toggle"
      >
        <span>
          本链内已累积：{llmCount} 次 thinking · {toolCount} 次 tool 交互
        </span>
        <span className="font-mono">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <ul
          className="mt-1.5 space-y-1.5"
          data-testid="llm-chain-history-list"
        >
          {history.map((n) => (
            <NodeNavRow
              key={n.id}
              node={n}
              onPanelView={onPanelView}
              onCanvasLocate={onCanvasLocate}
              testIdPrefix="llm-chain-history"
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// PR 2-C: walk parentUuid backward from ``start`` through the
// WorkFlow's nodes until the chain breaks (parentUuid resolves to a
// node not in this WorkFlow — chain root, or a llm_call's parent
// outside this WorkFlow). Returns predecessors in most-recent-first
// order, EXCLUDING the start node itself. Bounded to len(nodes) hops
// so a malformed cycle can't wedge.
function walkChainBackward(
  start: LlmCallNode,
  nodes: WorkNode[],
): WorkNode[] {
  const byId = new Map<string, WorkNode>(nodes.map((n) => [n.id, n]));
  // ToolCall lookup by resultUserUuid: llm_N.parentUuid normally
  // points at tool_M.resultUserUuid (the tool_result user record),
  // not at tool_M.id directly. So building this index lets the walk
  // find the right tool from a continuation parentUuid.
  const byResultUserUuid = new Map<string, WorkNode>();
  for (const n of nodes) {
    if (n.kind === "tool_call" || n.kind === "delegate") {
      if (n.resultUserUuid) byResultUserUuid.set(n.resultUserUuid, n);
    }
  }
  const out: WorkNode[] = [];
  const visited = new Set<string>([start.id]);
  let cursorParent = start.parentUuid;
  for (let i = 0; i < nodes.length && cursorParent; i += 1) {
    const next =
      byId.get(cursorParent) ?? byResultUserUuid.get(cursorParent) ?? null;
    if (!next) break; // parentUuid points outside this WorkFlow → chain root reached
    if (visited.has(next.id)) break; // defensive against cycles
    visited.add(next.id);
    out.push(next);
    // Compact = explicit chain break (prior context replaced with
    // summary). Include it in the history but stop walking — the
    // LLM that's currently being inspected didn't see anything before
    // this point as raw content.
    if (next.kind === "compact") break;
    cursorParent =
      next.kind === "llm_call" ||
      next.kind === "tool_call" ||
      next.kind === "delegate" ||
      next.kind === "attachment"
        ? next.parentUuid
        : null;
  }
  return out;
}

// PR 2.2: chain_position — UI metadata about where this llm_call
// sits in the WorkFlow's chain topology. Returns null when not a
// chain root (= mid-chain llm_calls don't get this row).
//
// Important caveats for inferring "why" the chain broke (revised after
// reading CC source — src/services/compact/compact.ts +
// utils/sessionStorage.ts:applyPreservedSegmentRelinks):
//
//   - CC compactions usually carry a preservedSegment that the loader
//     uses to re-stitch parentUuid links across the boundary; a
//     CompactNode appearing in a WorkFlow does NOT mean the chain
//     actually broke there.
//   - microcompact_boundary doesn't restructure the chain at all; it
//     only clears tool_result caches.
//   - api_error retries don't break the chain.
//   - True breakpoints (`/clear`, `/escape` mid-turn, partial compact
//     without preservedSegment, cross-session resume edge cases) often
//     leave NO local WorkFlow signal that Loomscope can pin down.
//
// So the UI shows the chain-root status as a fact, lists ALL non-llm
// WorkNodes between the previous-chain tail and this node as candidate
// evidence, and explicitly says Loomscope cannot precisely identify
// the cause.

type ChainGapEvidence = CompactNode | AttachmentNode;

interface ChainPositionFirstInWorkflow {
  kind: "first-in-workflow";
}
interface ChainPositionWithPrev {
  kind: "chain-root-with-prev";
  // The most recent llm_call in document order that belongs to a
  // DIFFERENT chain — i.e. the previous chain's tail.
  previousChainTail: LlmCallNode;
  // Every non-llm/non-tool WorkNode between previousChainTail and
  // this node, in document order. Surfaced as a hint list — NOT a
  // root-cause assertion. May be empty (= no local evidence; the
  // break likely happened off-WorkFlow, e.g. /clear / cross-session).
  gapEvidence: ChainGapEvidence[];
}
type ChainPosition = ChainPositionFirstInWorkflow | ChainPositionWithPrev;

function computeChainPosition(
  node: LlmCallNode,
  nodes: WorkNode[],
): ChainPosition | null {
  // Walk parentUuid back through the WorkFlow until we either find an
  // llm_call (= mid-chain, not a root) or hit a CompactNode / dead
  // end (= chain root). Attachment is chain transit (information
  // flow stays continuous through task_reminder /
  // deferred_tools_delta /etc.); compact is a hard break (prior
  // turn's content is replaced with summary in the next API call).
  const byId = new Map<string, WorkNode>(nodes.map((n) => [n.id, n]));
  const byResultUserUuid = new Map<string, WorkNode>();
  for (const n of nodes) {
    if ((n.kind === "tool_call" || n.kind === "delegate") && n.resultUserUuid) {
      byResultUserUuid.set(n.resultUserUuid, n);
    }
  }
  const visited = new Set<string>([node.id]);
  let cursor = node.parentUuid;
  let foundLlmPredecessor = false;
  for (let i = 0; i < nodes.length && cursor && !foundLlmPredecessor; i += 1) {
    const next = byId.get(cursor) ?? byResultUserUuid.get(cursor) ?? null;
    if (!next || visited.has(next.id)) break;
    if (next.kind === "llm_call") {
      foundLlmPredecessor = true;
      break;
    }
    if (next.kind === "compact") break; // explicit chain break
    visited.add(next.id);
    cursor = next.parentUuid;
  }
  if (foundLlmPredecessor) return null; // mid-chain, not a root

  // workflow.nodes is sorted chronologically by buildWorkflow (see
  // workflow-builder.ts tail), so a plain array slice is the right
  // way to find prev tail + gap evidence — earlier we needed an
  // ad-hoc timestamp resort because nodes was grouped by kind.
  const nodeIdx = nodes.findIndex((n) => n.id === node.id);
  let prevTail: LlmCallNode | null = null;
  for (let i = nodeIdx - 1; i >= 0; i -= 1) {
    const candidate = nodes[i];
    if (candidate.kind === "llm_call") {
      prevTail = candidate;
      break;
    }
  }

  if (!prevTail) {
    return { kind: "first-in-workflow" };
  }

  const prevTailIdx = nodes.indexOf(prevTail);
  const gapEvidence: ChainGapEvidence[] = [];
  for (let i = prevTailIdx + 1; i < nodeIdx; i += 1) {
    const between = nodes[i];
    if (between.kind === "compact" || between.kind === "attachment") {
      gapEvidence.push(between);
    }
  }
  return {
    kind: "chain-root-with-prev",
    previousChainTail: prevTail,
    gapEvidence,
  };
}

function ChainPositionRow({
  position,
  onPanelView,
  onCanvasLocate,
}: {
  position: ChainPosition;
  onPanelView: (id: string) => void;
  onCanvasLocate: (id: string) => void;
}) {
  if (position.kind === "first-in-workflow") {
    return (
      <p
        className="mt-1.5 text-[10px] italic text-gray-500"
        data-testid="llm-chain-position-first"
      >
        chain_position: WorkFlow 起点（这是本 ChatNode 的第 1 条链）
      </p>
    );
  }
  const tail = position.previousChainTail;
  return (
    <div
      className="mt-1.5 flex flex-col gap-1 rounded border border-amber-200 bg-amber-50/60 px-2 py-1 text-[10px] text-amber-800"
      data-testid="llm-chain-position-with-prev"
    >
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <span className="font-mono uppercase tracking-wide">chain_position:</span>
        <span>新链起点 ←</span>
        <span>前一条链结束于</span>
        <button
          type="button"
          onClick={() => onPanelView(tail.id)}
          onDoubleClick={() => onCanvasLocate(tail.id)}
          className="inline-flex items-center gap-1 rounded border border-amber-300 bg-white px-1.5 py-0.5 font-mono text-amber-900 hover:border-amber-500 hover:bg-amber-100 transition-colors"
          title="单击：在面板查看 / 双击：在画布定位"
          data-testid="llm-chain-position-tail-link"
        >
          {tail.id.slice(0, 8)}
        </button>
      </div>
      {(() => {
        const compact = position.gapEvidence.find(
          (ev) => ev.kind === "compact",
        ) as CompactNode | undefined;
        if (compact) {
          // Confident verdict: compact replaces prior context with a
          // summary, so post-compact chain start is unambiguously
          // caused by the compact even if other attachments also live
          // in the gap.
          const preTokens = compact.preTokens;
          return (
            <div
              className="flex flex-col gap-1"
              data-testid="llm-chain-position-cause-compact"
            >
              <div className="flex flex-wrap items-center gap-x-1.5">
                <span>因 compact 断链 ←</span>
                <button
                  type="button"
                  onClick={() => onPanelView(compact.id)}
                  onDoubleClick={() => onCanvasLocate(compact.id)}
                  className="inline-flex items-center gap-1 rounded border border-amber-300 bg-white px-1.5 py-0.5 font-mono text-amber-900 hover:border-amber-500 hover:bg-amber-100 transition-colors"
                  title="单击：在面板查看 compact / 双击：在画布定位"
                  data-testid="llm-chain-position-compact-link"
                >
                  compact {compact.id.slice(0, 8)}
                </button>
                {typeof preTokens === "number" && (
                  <span className="font-mono text-[10px]">
                    preTokens {formatTokens(preTokens)}
                  </span>
                )}
              </div>
              <p className="text-amber-600/80 italic">
                CC 在中段触发 compact，前面对话被替换为摘要再发给下一轮 API；
                post-compact 的 input 上下文已经是 fresh start。
              </p>
            </div>
          );
        }
        // No compact in gap — fall back to evidence list (likely
        // /clear / cross-session resume / partial compact without
        // local boundary node, etc.).
        return (
          <>
            {position.gapEvidence.length > 0 ? (
              <div
                className="flex flex-col gap-1"
                data-testid="llm-chain-position-evidence-list"
              >
                <span>本 WorkFlow 内在两条链之间出现：</span>
                <ul className="ml-3 flex flex-col gap-1 list-disc">
                  {position.gapEvidence.map((ev) => (
                    <li key={ev.id}>
                      <button
                        type="button"
                        onClick={() => onPanelView(ev.id)}
                        onDoubleClick={() => onCanvasLocate(ev.id)}
                        className="inline-flex items-center gap-1 rounded border border-amber-300 bg-white px-1.5 py-0.5 font-mono text-amber-900 hover:border-amber-500 hover:bg-amber-100 transition-colors"
                        title="单击：在面板查看 / 双击：在画布定位"
                        data-testid={`llm-chain-position-evidence-${ev.id}`}
                      >
                        {ev.kind} {ev.id.slice(0, 8)}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <span data-testid="llm-chain-position-no-evidence">
                本 WorkFlow 内在两条链之间没有可见证据。
              </span>
            )}
            <p className="mt-0.5 text-amber-600/80 italic">
              ⚠ 无 compact 痕迹但 chain 在此重置 — 可能是 /clear、/escape
              mid-turn、cross-session resume 或 partial compact 不带
              preservedSegment。
            </p>
          </>
        );
      })()}
    </div>
  );
}

// ── tool_call ─────────────────────────────────────────────────────────

function ToolCallDetail({ node, sessionId }: { node: ToolCallNode; sessionId: string }) {
  const patch = useMemo(() => extractStructuredPatch(node.toolUseResult), [node]);
  // Detect overflow refId — when the tool_result block content is a
  // ContentReplacementRecord ``{type:'content_replacement', refId}``
  // (CC source ``utils/toolResultStorage.ts``), Loomscope routes
  // through the chunked endpoint instead of inlining the (missing)
  // text.
  const overflowRefId = useMemo(() => extractOverflowRefId(node.resultBlock), [node]);

  return (
    <>
      <Section title="Tool">
        <ul className="text-[11px] text-gray-700 font-mono space-y-0.5">
          <li>name: {node.toolName}</li>
          {node.durationMs != null && <li>durationMs: {node.durationMs}</li>}
          {node.isError && (
            <li className="text-rose-700 font-semibold">✗ failed</li>
          )}
        </ul>
      </Section>

      <Section title="Input">
        {node.toolName === "Bash" && typeof (node.input as Record<string, unknown> | null)?.command === "string" ? (
          <BashInputView input={node.input as Record<string, unknown>} />
        ) : (
          <JsonView value={node.input} />
        )}
      </Section>

      {patch ? (
        <Section title="Diff" testId="tool-result-diff-section">
          <DiffView hunks={patch.hunks} filePath={patch.filePath} />
        </Section>
      ) : null}

      {overflowRefId ? (
        <Section title={`Tool result (overflow · ${overflowRefId})`}>
          <ToolResultOverflow sessionId={sessionId} refId={overflowRefId} />
        </Section>
      ) : (
        <Section title="Tool result">
          {patch ? (
            <div className="text-[10px] italic text-gray-400">
              （详见上方 Diff 渲染；下面是原始 JSON）
            </div>
          ) : null}
          {node.resultBlock != null ? (
            <JsonView value={node.resultBlock} />
          ) : node.toolUseResult != null ? (
            <JsonView value={node.toolUseResult} />
          ) : (
            <div className="text-[11px] italic text-gray-400">(无 result)</div>
          )}
        </Section>
      )}
    </>
  );
}

function BashInputView({ input }: { input: Record<string, unknown> }) {
  const command = String(input.command ?? "");
  const description = typeof input.description === "string" ? input.description : null;
  const runInBg = input.run_in_background === true;
  return (
    <div className="space-y-1.5">
      {description && (
        <div className="text-[11px] text-gray-700">{description}</div>
      )}
      <pre className="m-0 rounded bg-gray-900 px-2 py-1.5 text-[11px] font-mono text-gray-100 overflow-x-auto whitespace-pre-wrap">
        {command}
      </pre>
      {runInBg && (
        <div className="text-[10px] text-amber-700">⏳ run_in_background</div>
      )}
    </div>
  );
}

function ToolResultOverflow({
  sessionId,
  refId,
}: {
  sessionId: string;
  refId: string;
}) {
  const { text, totalSize, loadedBytes, hasMore, loading, error, loadMore } =
    useToolResultChunks(sessionId, refId);
  const ref = useRef<HTMLDivElement | null>(null);

  // Scroll-driven "load more": when the user scrolls within 400px of
  // the bottom, request the next chunk. Cheap (one call per chunk).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      if (!hasMore || loading) return;
      const { scrollTop, scrollHeight, clientHeight } = el;
      if (scrollHeight - (scrollTop + clientHeight) < 400) {
        loadMore();
      }
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [hasMore, loading, loadMore]);

  return (
    <div className="space-y-1">
      <div className="text-[10px] text-gray-500 font-mono">
        {totalSize != null ? (
          <>
            {formatBytes(loadedBytes)} / {formatBytes(totalSize)} loaded
            {hasMore && " · 滚到底部加载更多"}
          </>
        ) : loading ? (
          "loading…"
        ) : (
          ""
        )}
      </div>
      <div
        ref={ref}
        className="max-h-[400px] overflow-auto rounded bg-gray-50 border border-gray-200 p-2 text-[11px] font-mono text-gray-800 whitespace-pre-wrap"
        data-testid="tool-result-overflow-scroll"
      >
        {text}
        {loading && (
          <div className="mt-1 text-[10px] text-gray-400">loading next chunk…</div>
        )}
      </div>
      {error && (
        <div className="text-[10px] text-rose-700">load failed: {error}</div>
      )}
    </div>
  );
}

// Detect a tool-result overflow refId from the resultBlock. CC v2.1.104+
// writes overflow as a `<persisted-output>` text marker inside the
// tool_result content string, not a structured ContentReplacementRecord
// — the marker carries an absolute path whose basename is "<refId>.txt".
//
// Also accept the documented ContentReplacementRecord shape
// (older / hypothetical CC versions, plus future-proofing) so the
// extractor works across CC writer-side variants.
const PERSISTED_OUTPUT_PATH_RE =
  /tool-results\/([A-Za-z0-9_-]+)\.txt/;

export function extractOverflowRefId(block: unknown): string | null {
  if (!block || typeof block !== "object") return null;
  const b = block as { content?: unknown };

  // Modern CC: content is a string with a `<persisted-output>` marker
  // referencing the on-disk file.
  if (typeof b.content === "string") {
    if (b.content.includes("<persisted-output>")) {
      const match = b.content.match(PERSISTED_OUTPUT_PATH_RE);
      if (match?.[1]) return match[1];
    }
    return null;
  }

  // ContentReplacementRecord (object form) — content is the record itself.
  if (b.content && typeof b.content === "object" && !Array.isArray(b.content)) {
    const c = b.content as Record<string, unknown>;
    if (c.type === "content_replacement" && typeof c.refId === "string") {
      return c.refId;
    }
  }
  // ContentReplacementRecord nested inside an array of blocks. Also
  // check string children for the persisted-output marker — some CC
  // versions emit a plain text block alongside the structured record.
  if (Array.isArray(b.content)) {
    for (const inner of b.content) {
      if (typeof inner === "string" && inner.includes("<persisted-output>")) {
        const match = inner.match(PERSISTED_OUTPUT_PATH_RE);
        if (match?.[1]) return match[1];
      }
      if (inner && typeof inner === "object") {
        const i = inner as Record<string, unknown>;
        if (i.type === "content_replacement" && typeof i.refId === "string") {
          return i.refId;
        }
        if (typeof i.text === "string" && i.text.includes("<persisted-output>")) {
          const match = i.text.match(PERSISTED_OUTPUT_PATH_RE);
          if (match?.[1]) return match[1];
        }
      }
    }
  }
  return null;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// ── delegate ──────────────────────────────────────────────────────────

function DelegateDetail({ node, sessionId }: { node: DelegateNode; sessionId: string }) {
  const { t } = useTranslation();
  const isAutoCompact = (node.agentId ?? "").startsWith("acompact-");
  const enterSubWorkflow = useStore((s) => s.enterSubWorkflow);
  // Subscribe to the sub-agent cache entry for this delegate so the
  // panel reflects in-flight / error state from a parallel drill.
  const cacheEntry = useStore((s) =>
    node.agentId
      ? s.sessions.get(sessionId)?.subAgentCache.get(node.agentId) ?? null
      : null,
  );
  return (
    <>
      <Section title="Sub-agent">
        <ul className="text-[11px] text-gray-700 font-mono space-y-0.5">
          <li>agentType: {node.agentType ?? "—"}</li>
          {node.agentId && <li>agentId: {node.agentId}</li>}
          {node.status && <li>status: {node.status}</li>}
          {node.totalDurationMs != null && <li>totalDurationMs: {node.totalDurationMs}</li>}
          {node.totalTokens != null && <li>totalTokens: {node.totalTokens}</li>}
          {node.totalToolUseCount != null && (
            <li>totalToolUseCount: {node.totalToolUseCount}</li>
          )}
        </ul>
        {isAutoCompact && (
          <div className="mt-1.5 inline-flex items-center rounded bg-purple-200/80 px-1.5 py-0.5 text-[10px] font-semibold text-purple-900">
            ⊞ auto-compact agent
          </div>
        )}
        {node.agentId ? (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => enterSubWorkflow(sessionId, node.id)}
              className={[
                "inline-flex items-center gap-1 rounded border px-2 py-1 text-[11px] transition-colors",
                cacheEntry?.status === "loading"
                  ? "border-gray-200 bg-gray-50 text-gray-400 cursor-wait"
                  : "border-purple-300 bg-purple-50 text-purple-800 hover:border-purple-500 hover:bg-purple-100",
              ].join(" ")}
              disabled={cacheEntry?.status === "loading"}
              data-testid="drill-into-subagent"
            >
              {cacheEntry?.status === "loading"
                ? t("buttons.enter_subworkflow_loading")
                : t("buttons.enter_subworkflow_glyph")}
            </button>
            {cacheEntry?.status === "error" && (
              <div className="mt-1 text-[10px] text-rose-700">
                load failed: {cacheEntry.error ?? "unknown error"}
              </div>
            )}
            {cacheEntry?.status === "ready" &&
              cacheEntry.chatFlow &&
              cacheEntry.chatFlow.chatNodes.length > 1 && (
                <div className="mt-1 text-[10px] text-amber-700">
                  ⚠ sub-agent has {cacheEntry.chatFlow.chatNodes.length} ChatNodes;
                  v0.5 shows the first only
                </div>
              )}
          </div>
        ) : (
          <div className="mt-1.5 text-[10px] text-gray-400">
            (no agentId — sub-agent sidecar can't be located)
          </div>
        )}
      </Section>

      {cacheEntry?.meta?.worktreePath && (
        <Section title="Sub-agent meta">
          <ul className="text-[11px] text-gray-700 font-mono space-y-0.5">
            <li>worktreePath: {cacheEntry.meta.worktreePath}</li>
          </ul>
        </Section>
      )}

      {node.description && (
        <Section title="Description">
          <MarkdownView className="prose prose-sm max-w-none text-[12px] text-gray-900">
            {node.description}
          </MarkdownView>
        </Section>
      )}

      {node.prompt && (
        <Section title="Prompt">
          <MarkdownView className="prose prose-sm max-w-none text-[12px] text-gray-700">
            {node.prompt}
          </MarkdownView>
        </Section>
      )}

      {node.content && (
        <Section title="Content (final reply)">
          <MarkdownView className="prose prose-sm max-w-none text-[12px] text-gray-900">
            {node.content}
          </MarkdownView>
        </Section>
      )}

      {node.toolStats && (
        <Section title="Tool stats">
          <JsonView value={node.toolStats} />
        </Section>
      )}

      {node.usage && (
        <Section title="Usage">
          <JsonView value={node.usage} />
        </Section>
      )}
    </>
  );
}

// ── compact ───────────────────────────────────────────────────────────

function CompactDetail({ node }: { node: CompactNode }) {
  const { t } = useTranslation();
  return (
    <>
      <Section title="Compact">
        <ul className="text-[11px] text-gray-700 font-mono space-y-0.5">
          <li>trigger: {node.trigger ?? "auto"}</li>
          {node.preTokens != null && <li>preTokens: {node.preTokens}</li>}
          {node.boundaryUuid && <li>boundaryUuid: {node.boundaryUuid}</li>}
          {node.logicalParentUuid && (
            <li>logicalParentUuid: {node.logicalParentUuid}</li>
          )}
        </ul>
      </Section>
      <Section title="Summary">
        {node.summaryText ? (
          <MarkdownView className="prose prose-sm max-w-none text-[12px] text-gray-700">
            {node.summaryText}
          </MarkdownView>
        ) : (
          <div className="text-[11px] italic text-gray-400">{t("placeholders.empty")}</div>
        )}
      </Section>
    </>
  );
}

// ── attachment ────────────────────────────────────────────────────────

function AttachmentDetail({ node }: { node: AttachmentNode }) {
  // v0.7 M5 (design choice 4A 精装): compact_file_reference gets a
  // dedicated dashed-gray fold-marker box that mirrors compact
  // ChatNode's chrome convention. CC's compact_file_reference is the
  // compressed form of a regular file attachment within a compact段 —
  // {filename, displayPath} kept, content discarded. Surfacing both
  // paths + an unambiguous ⊠ marker is the signal users need to know
  // "this attachment is here as a placeholder; read the file from disk
  // for the real content."
  if (node.attachmentType === "compact_file_reference") {
    return (
      <>
        <Section title="Attachment">
          <CompactFileReferenceCard raw={node.raw} />
        </Section>
        <Section title="Raw">
          <JsonView value={node.raw} />
        </Section>
      </>
    );
  }
  return (
    <>
      <Section title="Attachment">
        <ul className="text-[11px] text-gray-700 font-mono space-y-0.5">
          <li>type: {node.attachmentType}</li>
        </ul>
      </Section>
      <Section title="Raw">
        <JsonView value={node.raw} />
      </Section>
    </>
  );
}

function CompactFileReferenceCard({ raw }: { raw: unknown }) {
  // CC's compact_file_reference attachment shape:
  //   { attachment: { type: "compact_file_reference", filename, displayPath } }
  // displayPath is usually the absolute path; filename is the basename.
  // Either may be missing on edge-case CC versions.
  const att =
    raw && typeof raw === "object" && raw !== null
      ? ((raw as { attachment?: unknown }).attachment as
          | { filename?: unknown; displayPath?: unknown }
          | undefined)
      : undefined;
  const filename = typeof att?.filename === "string" ? att.filename : null;
  const displayPath = typeof att?.displayPath === "string" ? att.displayPath : null;
  return (
    <div
      data-testid="compact-file-reference-card"
      className="rounded border border-dashed border-gray-300 bg-gray-50 p-2.5"
    >
      <div className="flex items-center gap-1.5 mb-1">
        <span aria-hidden>📄</span>
        <span className="text-[12px] font-semibold text-gray-900 break-all">
          {filename || (
            <span className="italic text-gray-400 font-normal">(filename 缺失)</span>
          )}
        </span>
      </div>
      {displayPath && (
        <div
          className="font-mono text-[10px] text-gray-500 break-all"
          title={displayPath}
        >
          {displayPath}
        </div>
      )}
      <div className="mt-1.5 inline-flex items-center gap-1 rounded bg-gray-200/80 px-1.5 py-0.5 text-[10px] text-gray-700">
        <span aria-hidden>⊠</span>
        <span>content compacted</span>
      </div>
      <div className="mt-1 text-[10px] text-gray-400">
        原文不在 jsonl 中——需要从 disk 读取
      </div>
    </div>
  );
}
