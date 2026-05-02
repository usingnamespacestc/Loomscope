// Visual chrome for a single ChatNode (ChatFlow layer).
//
// Per `design-visual-language.md`:
//   - 用户消息预览 (80 char trunc)
//   - assistant 终末文本预览 (80 char)
//   - 底部 token 总数 / duration / tool 数  (v0.2 omits token bar/duration —
//     totals require re-aggregating usage; we surface tool / llm counts and
//     a thinking-char proxy for now)
//
// Compact ChatNodes get a teal/dashed chrome variant so they stand out;
// rich compact card lands in v0.6.

import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

import type { ChatNodeRFNode } from "@/canvas/layoutDag";

export function ChatNodeCard({ data, selected }: NodeProps<ChatNodeRFNode>) {
  const cn = data.chatNode;
  const compact = data.isCompactSummary;
  const triggerSchedule = cn.trigger === "scheduled";

  const containerClass = [
    "rounded-md border bg-white shadow-sm transition-colors",
    "px-3 py-2 text-xs leading-snug",
    compact
      ? "border-dashed border-teal-300 bg-teal-50"
      : "border-gray-300",
    selected ? "ring-2 ring-blue-400 ring-offset-1" : "",
  ].join(" ");

  return (
    <div
      className={containerClass}
      style={{ width: 320, minHeight: 130 }}
      data-testid={`chat-node-${cn.id}`}
    >
      <Handle type="target" position={Position.Left} className="!bg-gray-400" />

      <div className="flex items-center justify-between mb-1">
        <span className="font-mono text-[10px] text-gray-500">
          {compact ? "⊞ compact" : triggerSchedule ? "⏰ scheduled" : "💬 chat"}
        </span>
        <span className="font-mono text-[10px] text-gray-400">{cn.id.slice(0, 8)}</span>
      </div>

      <div className="text-gray-700 mb-1">
        <span className="text-gray-400 mr-1">用户:</span>
        <span className="text-gray-900">{data.userPreview || <em className="text-gray-300">(空)</em>}</span>
      </div>

      <div className="text-gray-700 mb-1">
        <span className="text-gray-400 mr-1">Agent:</span>
        <span className="text-gray-900">{data.assistantPreview || <em className="text-gray-300">(无回复)</em>}</span>
      </div>

      <div className="mt-2 flex items-center gap-3 text-[10px] text-gray-500 border-t border-gray-100 pt-1">
        <span>🧠 {data.llmCount}</span>
        <span>🔧 {data.toolCount}</span>
        {data.totalThinkingChars > 0 && (
          <span className="text-gray-400">
            ▸ thinking {Math.round(data.totalThinkingChars / 100) / 10}k
          </span>
        )}
      </div>

      <Handle type="source" position={Position.Right} className="!bg-gray-400" />
    </div>
  );
}
