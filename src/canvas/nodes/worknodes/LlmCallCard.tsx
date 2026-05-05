// llm_call WorkNode card. Folded chrome — text preview (first 120 char)
// + thinking-line count badge. Drill panel (v0.4) shows the full text +
// thinking blocks; this card just signals "an LLM turn happened, here's
// what it said".

import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

import {
  WF_NODE_SIZE,
  llmCallThinkingLines,
  previewLlmCallText,
  type LlmCallRFNode,
} from "@/canvas/layoutWorkflow";
import { NodeIdLine } from "@/canvas/nodes/chrome/NodeIdLine";
import { TokenBar } from "@/canvas/nodes/chrome/TokenBar";
import { useIsWorkNodeSelected } from "@/store/selectionHooks";
import { handleStyle, workNodeChromeClass } from "./cardChrome";

export function LlmCallCard({ id, data }: NodeProps<LlmCallRFNode>) {
  const n = data.workNode;
  const text = previewLlmCallText(n);
  const thinkingLines = llmCallThinkingLines(n);
  const isError = (n.errors?.length ?? 0) > 0;
  const accent = isError ? "rose" : "blue";
  const selected = useIsWorkNodeSelected(id);
  // Sum input + output (excluding cache lookups). v0.6 redo M4: model
  // invocation occurred → draw TokenBar.
  const inputTokens = numOrZero(n.usage?.input_tokens);
  const outputTokens = numOrZero(n.usage?.output_tokens);
  const totalTokens = inputTokens + outputTokens;
  const isRunning = (data as { isRunning?: boolean }).isRunning === true;

  return (
    <div
      className={workNodeChromeClass(accent, selected, isRunning)}
      style={{ width: WF_NODE_SIZE.llm_call.width }}
      data-testid={`worknode-llm_call-${n.id}`}
      data-worknode-kind="llm_call"
      data-running={isRunning ? "true" : "false"}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        style={handleStyle(data.hasIncomingEdge)}
      />
      <div className="flex items-center gap-1 mb-1">
        <span className="text-blue-600">⌘</span>
        <span className="text-[10px] font-medium text-blue-700">assistant</span>
        {n.model && (
          <span className="ml-auto font-mono text-[9px] text-gray-400 truncate max-w-[120px]">
            {n.model}
          </span>
        )}
      </div>
      {text ? (
        <div className="text-[11px] text-gray-900 break-words line-clamp-3">
          {text}
        </div>
      ) : (
        <div className="text-[11px] italic text-gray-400">(无文本输出)</div>
      )}
      {thinkingLines > 0 && (
        <div className="mt-1 text-[10px] text-gray-500">
          ▸ thinking ({thinkingLines} lines)
        </div>
      )}
      {isError && (
        <div className="mt-1 text-[10px] text-rose-700">
          ✗ {n.errors?.[0]?.type ?? "error"}
        </div>
      )}
      {totalTokens > 0 && <TokenBar tokens={totalTokens} />}
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

function numOrZero(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
