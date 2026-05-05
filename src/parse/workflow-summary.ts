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

  // EN (v0.9.2): full text per llm_call (DAG order = turn order
  // since the parser appends nodes as records arrive). Empty
  // strings dropped — those rounds were tool-only.
  // 中: 每条 llm_call 的完整 text 数组（按解析顺序 = 时间顺序），
  // 空文本跳过（那是纯工具调用 round）。
  const assistantText: string[] = [];
  for (const n of llms) {
    if (n.text && n.text.trim().length > 0) assistantText.push(n.text);
  }

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
  // EN (v0.9.2): data-shape "in flight" detection. Tool_call /
  // delegate without resultBlock = response not yet written; final
  // llm_call without stopReason = streaming response cut mid-stream.
  // Either condition means the ChatNode's work isn't complete from
  // the data's perspective. Drives running animation (combined with
  // isLatest + sessionLive on the client to gate against history
  // orphans).
  // 中: 数据形态判定"运行中"。tool_call/delegate 缺 resultBlock 或
  // 最末 llm_call 无 stopReason → 数据上未完成。客户端再结合
  // isLatest + sessionLive 决定是否真画动画（避免历史孤儿误亮）。
  let hasInFlightWork = false;
  // EN: empty workflow → user message just landed, assistant hasn't
  // produced anything yet (or only attachments + queue events
  // filtered out). The ChatNode is logically "in flight" — CC is
  // calling the model API. Without this case, a brand-new ChatNode
  // shows no animation until the first llm_call lands ~1-2s later;
  // if CC takes longer (cold model / high latency) sessionLive
  // decays at 5s and the user sees a static "stuck" card for the
  // remaining wait. The compact-only / slash-only ChatNodes don't
  // hit this branch because their workflow has CompactNode /
  // AttachmentNode entries → nodes.length > 0.
  // 中: workflow.nodes 为空 = user 消息刚到、assistant 还没产出
  // 任何东西 = 在飞。否则刚发消息那几秒动画不亮，超过 5s 后 5s
  // sessionLive 衰减反而把"等模型响应中"判成静止。
  if (nodes.length === 0) {
    hasInFlightWork = true;
  }
  if (!hasInFlightWork) {
    for (const n of nodes) {
      if (n.kind === "tool_call") {
        if (n.resultBlock == null) {
          hasInFlightWork = true;
          break;
        }
      } else if (n.kind === "delegate") {
        // DelegateNode shape (data/types.ts) doesn't carry
        // resultBlock directly — completion is signalled by status
        // presence and toolUseResult / content. Undefined status =
        // in-flight (CC writes status='completed'/'failed' on
        // resolution).
        if (n.status == null && n.toolUseResult == null) {
          hasInFlightWork = true;
          break;
        }
      }
    }
  }
  if (!hasInFlightWork && lastReal && !lastReal.stopReason) {
    hasInFlightWork = true;
  }

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
    assistantText,
    hasInFlightWork,
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

// EN: Count CONNECTED llm_call chains in the WorkFlow DAG.
//
// An llm_call B is a chain ROOT (= starts a new chain) iff its
// predecessor isn't reachable inside this WorkFlow:
//   direct:   B.parentUuid points at another llm_call's id
//   indirect: B.parentUuid is some tool_call's resultUserUuid AND
//             that tool_call's parentUuid points at an llm_call
//             (= the predecessor)
// Every llm_call that isn't a root continues an existing chain.
// Chain count = number of roots.
//
// chainCount=1 is the typical CC turn (user → llm → tool → llm
// → tool → llm:end_turn). chainCount>1 happens when CC's harness
// inserts a gap mid-turn (auto-compact, error retry, /escape
// resume, etc.) so the assistant's continuation chain breaks and
// a fresh one starts. Surfaced on the card as a 🔗 N chip when >1.
//
// 中: 数 WorkFlow DAG 里的连通 llm_call 链数。一个 llm_call B 是
// chain ROOT（新链开头）当它的 predecessor 在本 WorkFlow 内不可达
// （直接边 B.parentUuid==A.id，或间接边 B.parentUuid 是某 tool_call
// 的 resultUserUuid 且该 tool_call.parentUuid 是某 llm_call）。
// chainCount=root 数。chainCount=1 是常态（一次 CC turn 一条连续链
// 直到 end_turn）；>1 表示 CC harness 在 turn 中段插入了 gap
// （auto-compact / 错误重试 / /escape 续接等）导致链断开。
// ChatNodeCard 在 chainCount>1 时显示 🔗 N chip 提示。
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
