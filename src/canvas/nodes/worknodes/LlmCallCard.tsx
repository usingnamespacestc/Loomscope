// llm_call WorkNode card. Folded chrome — text preview (first 120 char)
// + thinking-line count badge. Drill panel (v0.4) shows the full text +
// thinking blocks; this card just signals "an LLM turn happened, here's
// what it said".

import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { useTranslation } from "react-i18next";

import {
  WF_NODE_SIZE,
  llmCallThinkingLines,
  previewLlmCallText,
  type LlmCallRFNode,
} from "@/canvas/layoutWorkflow";
import { NodeIdLine } from "@/canvas/nodes/chrome/NodeIdLine";
import { TokenBar } from "@/canvas/nodes/chrome/TokenBar";
import { maxContextForModel } from "@/data/modelContext";
import { useIsWorkNodeSelected } from "@/store/selectionHooks";
import { handleStyle, workNodeChromeClass } from "./cardChrome";

export function LlmCallCard({ id, data }: NodeProps<LlmCallRFNode>) {
  const { t } = useTranslation();
  const n = data.workNode;
  const text = previewLlmCallText(n);
  const thinkingLines = llmCallThinkingLines(n);
  const isError = (n.errors?.length ?? 0) > 0;
  const accent = isError ? "rose" : "blue";
  const selected = useIsWorkNodeSelected(id);
  // PR 2.3: token bar = cumulative context tokens (input + cache_read +
  // cache_creation), aligned with ChatNodeCard's contextTokens
  // formula. Rationale: CC's `usage.input_tokens` is the entire
  // messages array sent on this API call — already cumulative across
  // the chain (each subsequent llm_call sees prior thinking + tool_use
  // + tool_result). Adding output_tokens to that mixes accumulated
  // input with per-call output, producing a number with no clear
  // semantic meaning. Cumulative input (incl. cache hits) cleanly
  // expresses "how much context was sent here", which monotonically
  // grows along a chain and matches what users intuitively want.
  // Per-call delta (current input − prior chain llm_call's input)
  // lives in LlmCallDetail.
  const ctxTokens =
    numOrZero(n.usage?.input_tokens) +
    numOrZero(n.usage?.cache_read_input_tokens) +
    numOrZero(n.usage?.cache_creation_input_tokens);
  // PR 2.3 follow-up: pass the model-specific context window as
  // TokenBar's denominator. Without it the bar defaulted to 200k for
  // every llm_call regardless of model, so a Claude Opus 4.7
  // (actually 1M context) showed 498% clamped to 100% on a 997k call,
  // and a 40k call on the SAME model showed 20% (40/200) — same
  // ChatNode using a different denominator. modelContext.ts maps
  // `claude-opus*` to 1M; CC strips the [1m] suffix in jsonl so we
  // assume 1M for opus by default (per existing comment).
  const maxCtxTokens = maxContextForModel(n.model);
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
        <div className="text-[11px] italic text-gray-400">{t("placeholders.no_text_output")}</div>
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
      {ctxTokens > 0 && <TokenBar tokens={ctxTokens} maxTokens={maxCtxTokens} />}
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
