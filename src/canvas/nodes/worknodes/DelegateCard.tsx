// delegate (sub-agent) WorkNode card. v0.3 shipped the folded rich
// card; v0.5 surfaces the "double-click to drill" affordance + an
// auto-compact badge for harness-spawned agents (agentId starts with
// ``acompact-``). The double-click handler itself lives on
// WorkFlowCanvas — here we just hint the affordance.

import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

import {
  WF_NODE_SIZE,
  delegateContentPreview,
  type DelegateRFNode,
} from "@/canvas/layoutWorkflow";
import type { DelegateNode } from "@/data/types";
import { useIsWorkNodeSelected } from "@/store/selectionHooks";
import { handleStyle, workNodeChromeClass } from "./cardChrome";

export function DelegateCard({ id, data }: NodeProps<DelegateRFNode>) {
  const n = data.workNode;
  const failed = n.status === "failed" || n.isError === true;
  const isAutoCompact = (n.agentId ?? "").startsWith("acompact-");
  const accent = failed ? "rose" : "purple";
  const contentPreview = delegateContentPreview(n);
  const desc = (n.description ?? "").trim();
  const selected = useIsWorkNodeSelected(id);

  return (
    <div
      className={workNodeChromeClass(accent, selected)}
      style={{ width: WF_NODE_SIZE.delegate.width }}
      data-testid={`worknode-delegate-${n.id}`}
      data-worknode-kind="delegate"
      data-auto-compact={isAutoCompact ? "true" : "false"}
      title="Double-click to drill into sub-agent"
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        style={handleStyle(data.hasIncomingEdge)}
      />
      <div className="flex items-center gap-1 mb-1">
        <span>🤖</span>
        <span className="text-[10px] font-medium text-purple-700">Agent</span>
        {isAutoCompact ? (
          // Auto-compact badge replaces the agentType chip — the
          // underlying meta sometimes misreports agentType for these,
          // so the agentId prefix is the canonical signal.
          <span
            className="ml-1 inline-flex items-center rounded bg-purple-300/80 px-1 py-0.5 text-[9px] font-semibold text-purple-900"
            data-testid="auto-compact-badge"
            title="harness-spawned auto-compact agent"
          >
            ⊞ auto-compact
          </span>
        ) : (
          n.agentType && (
            <span className="ml-1 inline-flex items-center rounded bg-purple-200/80 px-1 py-0.5 text-[9px] font-semibold text-purple-900">
              {n.agentType}
            </span>
          )
        )}
        {failed && (
          <span className="ml-auto text-rose-600 font-bold" title="failed">
            ✗
          </span>
        )}
      </div>
      {desc && (
        <div className="text-[11px] text-gray-900 break-words line-clamp-2 mb-1">
          {desc}
        </div>
      )}
      <DelegateStats n={n} />
      {contentPreview && (
        <div className="mt-1 pt-1 border-t border-purple-200/60 text-[10px] text-gray-700 break-words line-clamp-2">
          <span className="text-purple-600 font-medium">Result: </span>
          {contentPreview}
        </div>
      )}
      {/* Drill affordance — small text hint at the bottom right. The
          actual handler is wired on WorkFlowCanvas's onNodeDoubleClick
          so it works whether the user double-clicks the card body or
          this hint specifically. Hidden when the delegate has no
          agentId (sidecar can't be located). */}
      {n.agentId && (
        <div className="mt-1 text-[9px] text-purple-500 italic text-right">
          ⤢ double-click to drill
        </div>
      )}
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        style={handleStyle(data.hasOutgoingEdge)}
      />
    </div>
  );
}

function DelegateStats({ n }: { n: DelegateNode }) {
  // Numbers in tool_result come back as strings — coerce defensively.
  const dur = numOrNull(n.totalDurationMs);
  const tokens = numOrNull(n.totalTokens);
  const calls = numOrNull(n.totalToolUseCount);
  if (dur == null && tokens == null && calls == null) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-gray-500 font-mono">
      {dur != null && <span title="totalDurationMs">⏱ {formatMs(dur)}</span>}
      {tokens != null && <span title="totalTokens">↕ {formatTokens(tokens)}</span>}
      {calls != null && <span title="totalToolUseCount">🔧 {calls}</span>}
    </div>
  );
}

function numOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}m${r}s`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
