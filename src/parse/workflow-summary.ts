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

// EN: Anthropic API stop_reasons that mean "this turn is truly done"
// — no further API call expected. Anything ELSE (notably 'tool_use'
// and 'pause_turn') means the assistant emitted control signals that
// CC's harness will consume and follow up with another API call, so
// from the user's perspective the turn is still in flight.
//
// Pre-fix the running-animation gate (workflow-summary.ts hasInFlight
// + livenessHooks useIsChatNodeRunning) treated any present
// stopReason as terminal, which caused the animation to flicker off
// during every tool→llm round inside a multi-step turn (stopReason=
// 'tool_use' set + all tool_results landed → "complete" → animation
// off; next API call's stream begins → animation back on). Limiting
// "terminal" to this whitelist keeps the animation continuous across
// the inter-call gap.
//
// 中: 真正 turn-end 的 stop_reason 集合。'tool_use' / 'pause_turn'
// 不算 terminal —— 模型只是发出了控制信号，CC 接着会再发一次 API。
// 之前把"有 stopReason 就当完成"导致动画在多轮 tool→llm 中段闪烁。
const TERMINAL_STOP_REASONS = new Set([
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "refusal",
]);

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
  // Optional uuid → parentUuid index covering ALL chain participants
  // in the bucket's raw records, including ones that don't become
  // WorkNodes (task_reminder/hook_additional_context attachments,
  // system/turn_duration / system/away_summary / etc.). Lets
  // chainCount walk through transit records the parser otherwise
  // drops, eliminating false-positive "chain breaks".
  chainParentByUuid?: Map<string, string>,
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
  const chainCount = computeChainCount(nodes, chainParentByUuid);
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
  if (
    !hasInFlightWork &&
    lastReal &&
    !TERMINAL_STOP_REASONS.has(lastReal.stopReason ?? "")
  ) {
    // Last llm_call's stopReason missing OR a non-terminal control
    // signal (tool_use / pause_turn). Either way another API call is
    // still expected — keep the running indicator lit through the
    // inter-call gap.
    hasInFlightWork = true;
  }

  const totalThinkingChars = nodes.reduce((acc, n) => {
    if (n.kind !== "llm_call") return acc;
    return acc + n.thinking.reduce((a, t) => a + (t.text?.length ?? 0), 0);
  }, 0);

  const contextTokens = lastReal ? llmCallContextTokens(lastReal.usage) : 0;
  const maxContextTokens = maxContextForModel(lastReal?.model);

  // v1.5: per-turn token totals for the persistent MessageMeta row.
  // Sum across ALL real llm_calls (not just the last) so a multi-
  // step turn shows total fresh input + total generation, not just
  // the final round.
  let inputTokens = 0;
  let outputTokens = 0;
  for (const n of llms) {
    const u = n.usage as Record<string, unknown> | undefined;
    if (!u) continue;
    const num = (k: string) =>
      typeof u[k] === "number" ? (u[k] as number) : 0;
    // input excludes cache_read (replay, not new work) — same
    // semantics as deriveContextTokens / Composer status bar.
    inputTokens += num("input_tokens") + num("cache_creation_input_tokens");
    outputTokens += num("output_tokens");
  }

  // v1.5: turn duration. nodes are appended in jsonl order so [0]
  // is earliest, [N-1] latest. Skip when either end has no
  // timestamp (rare — synthetic compact nodes lack one).
  let durationMs: number | null = null;
  if (nodes.length > 0) {
    const firstTs = nodes[0].timestamp;
    const lastTs = nodes[nodes.length - 1].timestamp;
    if (firstTs && lastTs) {
      const a = Date.parse(firstTs);
      const b = Date.parse(lastTs);
      if (!Number.isNaN(a) && !Number.isNaN(b) && b >= a) {
        durationMs = b - a;
      }
    }
  }

  // Inline compact boundary (hybrid ChatNodes only). Walk nodes in
  // DAG / chronological order, count text-carrying real llm_calls
  // BEFORE the first `compact` WorkNode, and that count is the index
  // where post-compact rounds start in `assistantText`. Defensively
  // returns undefined when no compact node is found (turn isn't
  // hybrid) — the consumer (Effective Context view) only reads it
  // when chatNode.hasInnerCompact is true.
  let innerCompactLlmCallBoundaryIdx: number | undefined;
  const compactNodeIdx = nodes.findIndex((n) => n.kind === "compact");
  if (compactNodeIdx >= 0) {
    let count = 0;
    for (let i = 0; i < compactNodeIdx; i++) {
      const n = nodes[i];
      if (
        n.kind === "llm_call" &&
        isRealLlmCall(n) &&
        n.text &&
        n.text.trim().length > 0
      ) {
        count += 1;
      }
    }
    innerCompactLlmCallBoundaryIdx = count;
  }

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
    inputTokens,
    outputTokens,
    durationMs,
    lastModel: lastReal?.model,
    toolUseFilePaths,
    innerCompactLlmCallBoundaryIdx,
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
function computeChainCount(
  nodes: WorkNode[],
  chainParentByUuid?: Map<string, string>,
): number {
  const llmIds = new Set<string>();
  for (const n of nodes) if (n.kind === "llm_call") llmIds.add(n.id);
  if (llmIds.size === 0) return 0;
  // Build the lookup indexes ONCE here rather than rebuilding them
  // inside hasInWorkflowLlmPredecessor for every llm_call (was O(N²) on
  // a workflow with many llm_calls).
  const byId = new Map<string, WorkNode>(nodes.map((n) => [n.id, n]));
  const byResultUserUuid = new Map<string, WorkNode>();
  for (const n of nodes) {
    if ((n.kind === "tool_call" || n.kind === "delegate") && n.resultUserUuid) {
      byResultUserUuid.set(n.resultUserUuid, n);
    }
  }
  let roots = 0;
  for (const n of nodes) {
    if (n.kind !== "llm_call") continue;
    if (
      !hasInWorkflowLlmPredecessor(n, byId, byResultUserUuid, chainParentByUuid)
    )
      roots += 1;
  }
  return roots;
}

// EN: walk parentUuid backward through the WorkFlow's nodes until we
// either hit another llm_call (= predecessor exists, NOT a chain root)
// or run out of resolvable nodes / hit a compact boundary (= chain
// root).
//
// CC's chain isn't a strict llm→tool→llm sequence in jsonl. The
// canonical predecessor walk needs to handle these transit kinds
// because each writes its own record between llm_N and llm_(N+1):
//
//   - tool_call / delegate: llm_(N+1).parentUuid = tool.resultUserUuid
//     (the user record carrying the tool_result).
//   - attachment: CC injects task_reminder / hook_additional_context
//     / deferred_tools_delta style records on the chain
//     (utils/sessionStorage.ts:154 says attachment IS a chain
//     participant). These are pure transit: the prior conversation
//     stays in the LLM's input verbatim → walk through.
//
// Compact, in contrast, is a HARD chain break in information-flow
// terms — the prior turn's content is replaced with a summary
// before being sent to the next API call. Even though CC's parentUuid
// topology stays continuous through the boundary, Loomscope's
// chain count reflects the user-facing semantics: post-compact
// llm_call sees fresh context, so it registers as a new chain root.
// CompactNode.parentUuid is left pointing at the (invisible)
// boundary record (PR 2.4-C revert), so the walk naturally
// dead-ends here.
//
// 中: 走 parentUuid 反向链直到 (a) 找到 llm_call（= 存在前驱，非链 root）
// (b) 走光 / 走到 compact 边界（= 链 root）。attachment 是真 transit
// （信息流连续）；compact 在信息流意义上是真断链（前面对话被摘要替换），
// 所以 walk 在 CompactNode 处自然 dead-end，post-compact llm_call 正确
// 地被识别为新的链 root。
function hasInWorkflowLlmPredecessor(
  llm: LlmCallNode,
  byId: Map<string, WorkNode>,
  byResultUserUuid: Map<string, WorkNode>,
  chainParentByUuid?: Map<string, string>,
): boolean {
  const visited = new Set<string>([llm.id]);
  let cursor: string | null = llm.parentUuid;
  // Bound by 2 × records-ish so a malformed cycle can't wedge the walk.
  // Use chainParentByUuid as the upper bound when present (covers
  // transit records that don't become WorkNodes); fall back to nodes
  // length when no map provided.
  const limit = (chainParentByUuid?.size ?? byId.size) + byId.size;
  for (let i = 0; i < limit && cursor; i += 1) {
    const next = byId.get(cursor) ?? byResultUserUuid.get(cursor) ?? null;
    if (next) {
      if (visited.has(next.id)) return false;
      if (next.kind === "llm_call") return true;
      // Compact boundary = explicit chain break. Stop walking even
      // though CompactNode.parentUuid would dead-end on its own next
      // iteration — explicit short-circuit makes the intent clear.
      if (next.kind === "compact") return false;
      visited.add(next.id);
      cursor = next.parentUuid;
      continue;
    }
    // No WorkNode at this uuid — could be a transit record
    // (task_reminder attachment / system/turn_duration / etc.) that
    // the parser didn't materialise as a node. Continue the walk
    // through chainParentByUuid if available; otherwise this is a
    // dead end (chain leaves the WorkFlow).
    const transitParent = chainParentByUuid?.get(cursor);
    if (!transitParent) return false;
    if (visited.has(cursor)) return false;
    visited.add(cursor);
    cursor = transitParent;
  }
  return false;
}
