// delegate (sub-agent) WorkNode card. v0.3 shipped the folded rich
// card; v0.5 added the auto-compact badge for harness-spawned agents
// (agentId starts with ``acompact-``); v0.9.1 follow-up replaces the
// invisible "right-click to drill" gesture with an explicit button —
// React Flow's built-in zoom-on-double-click and the unreachable
// browser context menu both ate the gesture, so an explicit click
// target on the card body is the only reliable affordance.

import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { useTranslation } from "react-i18next";

import {
  WF_NODE_SIZE,
  delegateContentPreview,
  type DelegateRFNode,
} from "@/canvas/layoutWorkflow";
import { NodeIdLine } from "@/canvas/nodes/chrome/NodeIdLine";
import { TokenBar } from "@/canvas/nodes/chrome/TokenBar";
import type { DelegateNode } from "@/data/types";
import { useIsWorkNodeSelected } from "@/store/selectionHooks";
import { useStore } from "@/store/index";
import { handleStyle, workNodeChromeClass } from "./cardChrome";

export function DelegateCard({ id, data }: NodeProps<DelegateRFNode>) {
  const n = data.workNode;
  const failed = n.status === "failed" || n.isError === true;
  const isAutoCompact = (n.agentId ?? "").startsWith("acompact-");
  const accent = failed ? "rose" : "purple";
  const contentPreview = delegateContentPreview(n);
  const desc = (n.description ?? "").trim();
  const selected = useIsWorkNodeSelected(id);
  const isRunning = (data as { isRunning?: boolean }).isRunning === true;

  return (
    <div
      className={workNodeChromeClass(accent, selected, isRunning)}
      style={{ width: WF_NODE_SIZE.delegate.width }}
      data-testid={`worknode-delegate-${n.id}`}
      data-worknode-kind="delegate"
      data-auto-compact={isAutoCompact ? "true" : "false"}
      data-running={isRunning ? "true" : "false"}
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
      {contentPreview && (
        <div className="mt-1 pt-1 border-t border-purple-200/60 text-[10px] text-gray-700 break-words line-clamp-2">
          <span className="text-purple-600 font-medium">Result: </span>
          {contentPreview}
        </div>
      )}
      {/* v0.9.1: explicit drill-into-sub-agent button. Sits between
          the text content (desc / Result) and the stats row so it
          reads as "act on this content"; mirrors ChatNodeCard's
          DrillButton pattern. Hidden when agentId missing (sidecar
          can't be located, drill would 404). */}
      {n.agentId && <SubAgentDrillButton workNodeId={n.id} />}
      <DelegateStats n={n} />
      {numOrNull(n.totalTokens) != null && (
        <TokenBar tokens={numOrNull(n.totalTokens) as number} />
      )}
      <NodeIdLine nodeId={n.id} />
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        style={handleStyle(data.hasOutgoingEdge)}
      />
    </div>
  );
}

// v0.9.1: drill-in button — same pattern as ChatNodeCard's DrillButton
// but purple-themed to match delegate chrome. Per-button Zustand
// subscription keeps re-renders local; e.stopPropagation() prevents
// the click from bubbling to RF's node-click handler (which would
// flip workflow selection unhelpfully).
function SubAgentDrillButton({ workNodeId }: { workNodeId: string }) {
  const { t } = useTranslation();
  const enter = useStore((s) => s.enterSubWorkflow);
  const activeId = useStore((s) => s.activeSessionId);
  return (
    <button
      type="button"
      className="mt-1 flex w-full items-center justify-center gap-1 rounded border border-purple-200 bg-purple-50 px-2 py-1 text-[10px] text-purple-700 hover:border-purple-400 hover:bg-purple-100 hover:text-purple-900 transition-colors"
      onClick={(e) => {
        e.stopPropagation();
        if (!activeId) return;
        enter(activeId, workNodeId);
      }}
      data-testid={`enter-subworkflow-${workNodeId}`}
    >
      <span>⤢</span>
      <span>{t("buttons.enter_subworkflow")}</span>
    </button>
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
