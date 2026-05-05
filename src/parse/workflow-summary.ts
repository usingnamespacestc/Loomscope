// Pre-compute the WorkflowSummary fields that ChatNodeCard and other
// canvas-only consumers read. Runs once on the server right after
// `buildWorkflow`, so the lite ChatFlow endpoint can ship a card-
// rendering payload without the bulky workflow.nodes (~86% of total
// JSON volume).
//
// Fields kept in lockstep with ChatNodeRFData usage in
// src/canvas/layoutDag.ts: assistantPreview / llmCount / toolCount /
// totalThinkingChars / contextTokens + maxContextTokens / lastModel /
// toolUseFilePaths. If a future card revision starts reading another
// workflow-derived field, surface it here so lazy-load doesn't break
// the canvas.

import { maxContextForModel } from "@/data/modelContext";
import type {
  Edge,
  LlmCallNode,
  WorkNode,
  WorkflowSummary,
} from "@/data/types";

const ASSISTANT_PREVIEW_LEN = 80;

// Skip llm_call records that aren't real API responses:
//   - model === "<synthetic>" — CC injects these for rate-limit (429),
//     interruption, or other harness-side fake assistant records.
//     Their usage fields are all 0 because no API call happened.
//   - errors[] non-empty — error responses also can't represent real
//     context state.
function isRealLlmCall(n: { model?: string; errors?: unknown[] }): boolean {
  if (n.model === "<synthetic>") return false;
  if (n.errors && n.errors.length > 0) return false;
  return true;
}

function llmCallContextTokens(usage?: Record<string, unknown>): number {
  if (!usage) return 0;
  const num = (k: string) =>
    typeof usage[k] === "number" ? (usage[k] as number) : 0;
  return (
    num("input_tokens") +
    num("cache_creation_input_tokens") +
    num("cache_read_input_tokens")
  );
}

export function computeWorkflowSummary(
  nodes: WorkNode[],
  _edges: Edge[],
): WorkflowSummary {
  const llms = nodes.filter(
    (n): n is LlmCallNode => n.kind === "llm_call" && isRealLlmCall(n),
  );
  const lastReal = llms.length > 0 ? llms[llms.length - 1] : undefined;

  const assistantPreviewSource = (() => {
    // Prefer the *last* llm_call's text (the agent's final reply this
    // turn). Falls back to earlier llm_calls if last has empty text.
    for (let i = llms.length - 1; i >= 0; i -= 1) {
      const n = llms[i];
      if (n.text?.trim()) return n.text;
    }
    return "";
  })();

  const toolCount = nodes.filter(
    (n) => n.kind === "tool_call" || n.kind === "delegate",
  ).length;
  const llmCount = nodes.filter((n) => n.kind === "llm_call").length;
  const chainCount = computeChainCount(nodes);

  const totalThinkingChars = nodes.reduce((acc, n) => {
    if (n.kind !== "llm_call") return acc;
    return acc + n.thinking.reduce((a, t) => a + (t.text?.length ?? 0), 0);
  }, 0);

  const contextTokens = lastReal ? llmCallContextTokens(lastReal.usage) : 0;
  const maxContextTokens = maxContextForModel(lastReal?.model);

  // file_paths from this turn's Edit/Write/MultiEdit/NotebookEdit
  // tool_use input — drives "本节点文件改动" delta computation.
  const toolUseFilePaths: string[] = [];
  for (const n of nodes) {
    if (n.kind !== "tool_call") continue;
    const input = n.input as Record<string, unknown> | undefined;
    if (!input) continue;
    if (
      n.toolName === "Edit" ||
      n.toolName === "Write" ||
      n.toolName === "MultiEdit"
    ) {
      const p = input["file_path"];
      if (typeof p === "string" && p.length > 0) toolUseFilePaths.push(p);
    } else if (n.toolName === "NotebookEdit") {
      const p = input["notebook_path"];
      if (typeof p === "string" && p.length > 0) toolUseFilePaths.push(p);
    }
  }

  return {
    assistantPreview: truncate(assistantPreviewSource, ASSISTANT_PREVIEW_LEN),
    llmCount,
    chainCount,
    toolCount,
    totalThinkingChars,
    contextTokens,
    maxContextTokens,
    lastModel: lastReal?.model,
    toolUseFilePaths,
  };
}

function truncate(s: string, max: number): string {
  const cleaned = s.replace(/\s+/g, " ").trim();
  return cleaned.length <= max ? cleaned : cleaned.slice(0, max - 1) + "…";
}

// Count connected llm_call chains in the WorkFlow DAG. An llm_call B
// is a chain ROOT (= starts a new chain) iff its predecessor isn't
// reachable inside this WorkFlow:
//   - direct: B.parentUuid points at another llm_call's id
//   - indirect: B.parentUuid is some tool_call's resultUserUuid, AND
//     that tool_call's parentUuid points at an llm_call (= the
//     predecessor)
// Every llm_call that isn't a root continues an existing chain.
// Chain count = number of roots.
//
// Intuition: chainCount=1 is the typical CC turn (user → llm → tool
// → llm → tool → llm:end_turn). chainCount>1 happens when CC's
// harness inserts a gap mid-turn (auto-compact, error-retry,
// /escape resume) so the assistant's continuation chain breaks and
// a fresh one starts.
function computeChainCount(nodes: WorkNode[]): number {
  const llmIds = new Set<string>();
  for (const n of nodes) if (n.kind === "llm_call") llmIds.add(n.id);
  if (llmIds.size === 0) return 0;
  // resultUserUuid → tool_call.id (the tool_result that bridges
  // tool_call back to the next llm_call).
  const toolByResultUuid = new Map<string, string>();
  // tool_call.id → its parent llm_call id.
  const toolParentLlm = new Map<string, string>();
  for (const n of nodes) {
    if (n.kind !== "tool_call" && n.kind !== "delegate") continue;
    if (n.resultUserUuid) toolByResultUuid.set(n.resultUserUuid, n.id);
    if (n.parentUuid && llmIds.has(n.parentUuid)) {
      toolParentLlm.set(n.id, n.parentUuid);
    }
  }
  let roots = 0;
  for (const n of nodes) {
    if (n.kind !== "llm_call") continue;
    const p = n.parentUuid;
    if (!p) {
      roots += 1;
      continue;
    }
    // direct llm → llm continuation (rare but legal)
    if (llmIds.has(p)) continue;
    // indirect llm → tool_call → llm continuation via tool_result
    const toolId = toolByResultUuid.get(p);
    if (toolId && toolParentLlm.has(toolId)) continue;
    roots += 1;
  }
  return roots;
}
