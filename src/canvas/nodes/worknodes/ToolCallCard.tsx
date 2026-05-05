// tool_call WorkNode card. Folded chrome — 🔧 toolName + up to 3
// "key: value" input lines + first non-empty line of result.
//
// Failed tool_calls (``isError`` from the tool_result block, or any
// "is_error":true / "status":"failed" inside ``toolUseResult``) get
// rose accent + ✗ marker.

import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

import {
  WF_NODE_SIZE,
  previewToolInput,
  previewToolResult,
  type ToolCallRFNode,
} from "@/canvas/layoutWorkflow";
import { NodeIdLine } from "@/canvas/nodes/chrome/NodeIdLine";
import { useIsWorkNodeSelected } from "@/store/selectionHooks";
import { handleStyle, workNodeChromeClass } from "./cardChrome";

export function ToolCallCard({ id, data }: NodeProps<ToolCallRFNode>) {
  const n = data.workNode;
  const inputLines = previewToolInput(n);
  const resultPreview = previewToolResult(n);
  const failed = n.isError === true;
  const accent = failed ? "rose" : "amber";
  const selected = useIsWorkNodeSelected(id);
  // v0.9.2: data.isRunning decorated by WorkFlowCanvas based on
  // tool_call.resultBlock missing + parent ChatNode running.
  const isRunning = (data as { isRunning?: boolean }).isRunning === true;

  return (
    <div
      className={workNodeChromeClass(accent, selected, isRunning)}
      style={{ width: WF_NODE_SIZE.tool_call.width }}
      data-testid={`worknode-tool_call-${n.id}`}
      data-worknode-kind="tool_call"
      data-running={isRunning ? "true" : "false"}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        style={handleStyle(data.hasIncomingEdge)}
      />
      <div className="flex items-center gap-1 mb-1">
        <span className="text-amber-500">🔧</span>
        <span className="text-[11px] font-semibold text-gray-900 truncate">
          {n.toolName}
        </span>
        {failed && (
          <span className="ml-auto text-rose-600 font-bold" title="failed">
            ✗
          </span>
        )}
      </div>
      {inputLines.length > 0 && (
        <ul className="text-[10px] text-gray-700 font-mono space-y-0.5">
          {inputLines.map((line, i) => (
            <li key={i} className="truncate" title={line}>
              {line}
            </li>
          ))}
        </ul>
      )}
      {resultPreview && (
        <div className="mt-1 pt-1 border-t border-gray-200/60 text-[10px] text-gray-600">
          <span className={failed ? "text-rose-600" : "text-gray-500"}>
            {failed ? "✗" : "✓"}
          </span>{" "}
          <span className="break-words line-clamp-2">{resultPreview}</span>
        </div>
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
