// Synthetic ``awaySummary`` rfNode mirroring Agentloom's ChatBriefNodeCard
// pattern (memory: project_agentloom_chat_brief_canvas).
//
// CC writes ``type:"system" subtype:"away_summary"`` records when a
// session resumes after an idle gap; the parser attaches them as
// `chatNode.meta.awaySummary` on the FOLLOWING ChatNode (see
// docs/handoff-v1.2-summary-spike.md). v1.2 R5 surfaces these on the
// canvas as a small synthetic node positioned upstream of the host
// ChatNode (chronologically: "this summary covered the gap BEFORE
// the host turn"), connected by a dashed "anchor" edge (not a data
// flow — purely visual).
//
// Lives outside `chatFlow.chatNodes` — injected by `layoutChatFlow`
// when it sees `cn.meta.awaySummary`. Click expands/collapses the
// truncated body. Doesn't claim selection (e.stopPropagation on
// click — like ChatFoldNodeCard).

import { memo, useState } from "react";
import { Handle, Position } from "@xyflow/react";
import type { Node as RFNode, NodeProps } from "@xyflow/react";

export interface AwaySummaryNodeData extends Record<string, unknown> {
  /** Host ChatNode id (= the turn that follows the idle gap). The
   *  awaySummary lives on `host.meta.awaySummary`; we duplicate the
   *  content into the node data to avoid re-querying chatFlow at
   *  render time. */
  hostChatNodeId: string;
  /** The summary text body (verbatim from
   *  `system.subtype="away_summary"` record's content). */
  content: string;
  /** Optional ISO timestamp from the away_summary record. Lets the
   *  card show a relative-age hint ("5d ago" / "2h ago") when CC
   *  emitted it. Most CC versions populate this. */
  timestamp?: string;
}

export type AwaySummaryRFNode = RFNode<AwaySummaryNodeData, "awaySummary">;

const TRUNCATE_CHARS = 140;

function truncate(text: string, n: number): string {
  if (text.length <= n) return text;
  return `${text.slice(0, n - 1)}…`;
}

// Format a relative-age hint from an ISO timestamp. Conservative —
// returns empty string when undefined / unparseable so the badge
// area collapses cleanly instead of showing "Invalid Date".
function relativeAge(iso: string | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const deltaSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (deltaSec < 60) return `${deltaSec}s 前`;
  if (deltaSec < 3_600) return `${Math.floor(deltaSec / 60)}m 前`;
  if (deltaSec < 86_400) return `${Math.floor(deltaSec / 3_600)}h 前`;
  const days = Math.floor(deltaSec / 86_400);
  if (days < 30) return `${days}d 前`;
  return new Date(t).toLocaleDateString();
}

export const AwaySummaryNodeCard = memo(AwaySummaryNodeCardImpl);

function AwaySummaryNodeCardImpl({ data }: NodeProps<AwaySummaryRFNode>) {
  const [expanded, setExpanded] = useState(false);

  const onClick = (e: React.MouseEvent) => {
    // Don't claim selection — synthetic nodes shouldn't pollute
    // selection state. Same convention as ChatFoldNodeCard.
    e.stopPropagation();
    setExpanded((v) => !v);
  };

  const ageHint = relativeAge(data.timestamp);
  const body = data.content || "";
  const display = expanded || body.length <= TRUNCATE_CHARS
    ? body
    : truncate(body, TRUNCATE_CHARS);

  return (
    <div
      className="w-52 rounded-lg border border-amber-300 bg-amber-50/70 p-2 shadow-sm transition-colors hover:border-amber-400 hover:bg-amber-50 cursor-pointer"
      onClick={onClick}
      data-testid={`away-summary-${data.hostChatNodeId}`}
      title={expanded ? "点击收起" : "点击展开完整内容"}
    >
      <div className="mb-1 flex items-center gap-1.5">
        <span
          className="inline-flex items-center gap-0.5 rounded bg-amber-200/80 px-1 py-0.5 text-[10px] font-semibold text-amber-900"
          data-testid={`away-summary-badge-${data.hostChatNodeId}`}
        >
          💤 续接小结
        </span>
        {ageHint && (
          <span className="text-[10px] text-amber-700/80 font-mono">
            · {ageHint}
          </span>
        )}
      </div>
      {body ? (
        <div className="text-[10.5px] leading-snug text-amber-900/90 break-words italic">
          {display}
        </div>
      ) : (
        <span className="text-[10px] italic text-amber-600">（无内容）</span>
      )}

      {/* Source handle — synthetic edge to host ChatNode exits here.
          Hidden visually via 0×0 invisible style (the dashed edge alone
          carries the "anchor" semantic; we don't want a dot on this
          decorative card). */}
      <Handle
        id="away-anchor"
        type="source"
        position={Position.Right}
        isConnectable={false}
        style={{ background: "transparent", width: 0, height: 0, border: "none" }}
      />
    </div>
  );
}
