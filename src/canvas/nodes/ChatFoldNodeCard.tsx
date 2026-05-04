// Synthetic ``chatFold`` rfNode visualizing a folded compact range.
//
// Sits UPSTREAM of the host compact card on the LR canvas, representing
// every ChatNode that has been absorbed into the host's fold. The host
// compact card itself stays unchanged — the chatFold is purely an
// "everything before me, summarised" visual placeholder.
//
// The card is intentionally low-density per design lock: count + host's
// preTokens (when known) + a click-to-unfold hint. No mini-list of the
// folded ChatNodes (Agentloom shipped that as a 2026-04-25 follow-up
// after the foundation; Loomscope follows the same staged approach).
//
// Click the card → ``unfoldCompact(activeSessionId, hostCompactId)``.
// React Flow's ``onNodeClick`` on the canvas would fire too, but we
// stop propagation here to keep selection on the previously-selected
// real ChatNode (the chatFold is view-only, not a selectable node).

import { Handle, Position } from "@xyflow/react";
import type { Node as RFNode, NodeProps } from "@xyflow/react";

import { formatTokensKM } from "@/canvas/layoutDag";
import { useStore } from "@/store/index";

export interface ChatFoldNodeData extends Record<string, unknown> {
  // The compact ChatNode whose pre-compact range this fold represents.
  // ``unfoldCompact`` consumes this id; click also routes here.
  hostCompactId: string;
  // Number of hidden ChatNodes attributed to this fold.
  count: number;
  // The id of the chatFold's "tail" claimed member — i.e. the
  // pre-host ChatNode that an outgoing edge boundary fork would have
  // pointed at. Surfaced to the card mostly so M3's edge reroute
  // logic + the card's debug tooltip share the same identifier.
  lastMemberId: string;
  // host compact's preTokens (when known) — = "the context window
  // size CC compressed when this compact ran". Treated as the most
  // representative aggregate-tokens figure for the range.
  preTokens?: number;
}

export type ChatFoldRFNode = RFNode<ChatFoldNodeData, "chatFold">;

export function ChatFoldNodeCard({ data }: NodeProps<ChatFoldRFNode>) {
  const activeId = useStore((s) => s.activeSessionId);
  const unfold = useStore((s) => s.unfoldCompact);

  const onClick = (e: React.MouseEvent) => {
    // React Flow normally selects the node on click; the chatFold
    // isn't a real ChatNode and shouldn't claim selection. Stop
    // propagation so onNodeClick on the canvas doesn't get a turn
    // and call setSelected with a nonexistent ChatNode id.
    e.stopPropagation();
    if (!activeId) return;
    unfold(activeId, data.hostCompactId);
  };

  return (
    <div
      className="w-52 rounded-lg border-2 border-dashed border-slate-400 bg-slate-50/80 p-2.5 text-slate-700 shadow-sm transition-colors hover:border-slate-500 hover:bg-slate-100 cursor-pointer"
      onClick={onClick}
      data-testid={`chatfold-${data.hostCompactId}`}
      title="Click to unfold the pre-compact range"
    >
      {/* Header: the fold marker symbol + "压缩前 N 节点" badge. */}
      <div className="mb-1.5 flex items-center gap-1.5">
        <span
          className="inline-flex items-center rounded bg-slate-200/80 px-1.5 py-0.5 font-medium text-[10px] text-slate-800"
          data-testid={`chatfold-badge-${data.hostCompactId}`}
        >
          ⊟ 折叠 {data.count} 节点
        </span>
        {typeof data.preTokens === "number" && data.preTokens > 0 && (
          <span className="text-[10px] text-slate-500">
            · {formatTokensKM(data.preTokens)}
          </span>
        )}
      </div>

      {/* Body: a brief explanation of what's hidden + the unfold hint. */}
      <div className="text-[10px] text-slate-600 leading-snug">
        pre-compact range —— compact summary 提炼自这段对话.
      </div>
      <div className="mt-1.5 text-[10px] text-slate-500 italic">
        点击展开
      </div>

      {/* Handles: edges enter from the left (the first range member's
          original incoming continuation edge target is rerouted here),
          and exit on the right (to the host compact card). M3 wires
          edge.targetHandle / sourceHandle accordingly. */}
      <Handle
        id="fold-input"
        type="target"
        position={Position.Left}
        isConnectable={false}
        style={{ background: "#94a3b8", width: 5, height: 5, border: "none" }}
      />
      <Handle
        id="fold-output-right"
        type="source"
        position={Position.Right}
        isConnectable={false}
        style={{ background: "#94a3b8", width: 5, height: 5, border: "none" }}
      />
    </div>
  );
}
