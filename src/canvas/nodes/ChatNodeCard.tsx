// Visual chrome for a single ChatNode (ChatFlow layer).
//
// Faithfully ports Agentloom ChatFlowNodeCard's signature look so the
// two projects feel like family:
//   - w-52 (208px) narrow card, rounded-lg, p-2.5
//   - 3px colored left-accent strip based on state
//   - whole-card bg color when special state (compact/scheduled/root)
//   - selected: ring-2 ring-blue-200 + border-blue-500
//   - TokenBar at the bottom (blue → amber → rose gradient)
//   - text-[10px] colored micro-headers per section
//
// Loomscope-specific: handles are non-interactive (viewer mode) and
// invisible when no edge connects.

import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

import {
  TOKEN_BAR_DEFAULT_MAX,
  formatTokensKM,
  type ChatNodeRFNode,
} from "@/canvas/layoutDag";

export function ChatNodeCard({ data, selected }: NodeProps<ChatNodeRFNode>) {
  const cn = data.chatNode;
  const compact = data.isCompactSummary;
  const triggerSchedule = cn.trigger === "scheduled";
  const isRoot = cn.parentChatNodeId === null && !data.hasIncomingEdge;
  const isLeaf = !data.hasOutgoingEdge && !isRoot && !compact && !triggerSchedule;

  // Background tint by primary state.
  const bgClass = compact
    ? "bg-teal-50"
    : triggerSchedule
      ? "bg-amber-50"
      : isRoot
        ? "bg-blue-50/60"
        : isLeaf
          ? "bg-green-50"
          : "bg-white";

  // 3px left accent strip — Agentloom signature.
  const accentClass = compact
    ? "border-l-[3px] border-l-teal-500"
    : triggerSchedule
      ? "border-l-[3px] border-l-amber-500"
      : isRoot
        ? "border-l-[3px] border-l-blue-400"
        : isLeaf
          ? "border-l-[3px] border-l-green-400"
          : "";

  // Border color around the rest of the card.
  const borderClass = selected
    ? "border-blue-500 ring-2 ring-blue-200"
    : compact
      ? "border-teal-300"
      : triggerSchedule
        ? "border-amber-300"
        : isLeaf
          ? "border-green-300"
          : "border-gray-300 hover:border-gray-400";

  return (
    <div
      className={[
        "group/card relative w-52 rounded-lg border shadow-sm p-2.5 text-xs",
        "transition-colors leading-snug",
        bgClass,
        accentClass,
        borderClass,
      ].join(" ")}
      data-testid={`chat-node-${cn.id}`}
    >
      {/* Handles — invisible 0×0 when no edge connects (viewer mode). */}
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        style={
          data.hasIncomingEdge
            ? { background: "#94a3b8", width: 5, height: 5, border: "none" }
            : { background: "transparent", width: 0, height: 0, border: "none" }
        }
      />

      {/* Top row: state chip only (id moved to bottom — Agentloom convention) */}
      <div className="flex items-center mb-1.5 min-h-[14px]">
        {compact ? (
          <span className="inline-flex items-center gap-0.5 rounded bg-teal-200/80 px-1 py-0.5 text-[10px] font-semibold text-teal-900">
            ⊞ compact
          </span>
        ) : triggerSchedule ? (
          <span className="inline-flex items-center gap-0.5 rounded bg-amber-200/80 px-1 py-0.5 text-[10px] font-semibold text-amber-900">
            ⏰ scheduled
          </span>
        ) : isRoot ? (
          <span className="text-[10px] text-blue-600 font-medium">root</span>
        ) : isLeaf ? (
          <span className="text-[10px] text-green-700 font-medium">leaf</span>
        ) : (
          <span className="text-[10px] text-gray-400 font-medium">chat</span>
        )}
      </div>

      {/* User message */}
      <div className="mb-1.5">
        <div className="text-[10px] text-blue-600 mb-0.5 font-medium tracking-wide">用户</div>
        <div className="text-[11px] text-gray-900 break-words line-clamp-2">
          {data.userPreview || <span className="italic text-gray-300">(空)</span>}
        </div>
      </div>

      {/* Agent reply */}
      <div className="mb-1.5">
        <div className="text-[10px] text-purple-600 mb-0.5 font-medium tracking-wide">Agent</div>
        <div className="text-[11px] text-gray-900 break-words line-clamp-2">
          {data.assistantPreview || <span className="italic text-gray-300">(无回复)</span>}
        </div>
      </div>

      {/* Token bar */}
      {data.contextTokens > 0 && (
        <TokenBar tokens={data.contextTokens} maxTokens={data.maxContextTokens} />
      )}

      {/* Bottom stats row */}
      <div className="mt-1.5 flex items-center gap-2.5 text-[10px] text-gray-500 border-t border-gray-200/60 pt-1">
        <span className="inline-flex items-center gap-0.5">
          <span className="text-blue-500">🧠</span>
          <span className="font-mono">{data.llmCount}</span>
        </span>
        <span className="inline-flex items-center gap-0.5">
          <span className="text-amber-500">🔧</span>
          <span className="font-mono">{data.toolCount}</span>
        </span>
        {data.totalThinkingChars > 0 && (
          <span className="text-gray-400 font-mono">
            ▸{Math.round(data.totalThinkingChars / 100) / 10}k
          </span>
        )}
      </div>

      {/* Node id at bottom — Agentloom convention. Truncated mono, low
          contrast so it doesn't compete with content. */}
      <div
        className="mt-1 text-center font-mono text-[9px] text-gray-400 truncate"
        title={cn.id}
      >
        {cn.id.slice(0, 8)}
      </div>

      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        style={
          data.hasOutgoingEdge
            ? { background: "#94a3b8", width: 5, height: 5, border: "none" }
            : { background: "transparent", width: 0, height: 0, border: "none" }
        }
      />

      {/* Enter-WorkFlow drill button — visible on hover. v0.2 占位（点了
          仅 console.log），v0.3 inner WorkFlow 落地时接 store action 切到
          ChatNode 内部视图。Compact node 不展开内部 WorkFlow（其内部内容
          已被压缩进 summary）。 */}
      {!compact && (
        <button
          type="button"
          className="absolute -bottom-2.5 right-2 hidden h-5 items-center gap-0.5 rounded border border-blue-300 bg-white px-1.5 text-[10px] font-medium text-blue-600 shadow-sm transition-colors hover:bg-blue-50 group-hover/card:flex"
          onClick={(e) => {
            e.stopPropagation();
            // TODO v0.3: useStore.getState().drillIntoWorkflow(cn.id)
            console.debug("[v0.3 stub] drill into WorkFlow:", cn.id);
          }}
          title="进入工作流（v0.3 实现）"
          data-testid={`enter-workflow-${cn.id}`}
        >
          ⤢ 进入工作流
        </button>
      )}
    </div>
  );
}

// TokenBar — straight port of Agentloom's chrome. Blue → amber → rose as
// the context fills.
function TokenBar({
  tokens,
  maxTokens,
}: {
  tokens: number;
  maxTokens?: number | null;
}) {
  const denom = maxTokens && maxTokens > 0 ? maxTokens : TOKEN_BAR_DEFAULT_MAX;
  const pct = Math.min(100, (tokens / denom) * 100);
  const color =
    pct >= 90 ? "bg-rose-500" : pct >= 70 ? "bg-amber-400" : "bg-blue-400";
  return (
    <div className="mt-1" title={`${tokens} / ${formatTokensKM(denom)} tokens`}>
      <div className="flex items-center justify-between text-[9px] text-gray-500 mb-0.5">
        <span>{formatTokensKM(tokens)}</span>
        <span>{pct.toFixed(0)}%</span>
      </div>
      <div className="h-1 w-full rounded-full bg-gray-200 overflow-hidden">
        <div
          className={`h-1 rounded-full transition-all ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
