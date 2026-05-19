// EN (v2.1 PR D3): shared chatflow signature + hash helpers used by
// both server-side delta engine + client-side drift verification.
// Same algorithm both sides means a properly-applied delta stream
// produces matching hashes; mismatches indicate reducer drift.
//
// FNV-1a 32-bit chosen for: deterministic, no Node-only crypto deps
// (works in browser), fast enough for thousands of ChatNodes per
// hash, low collision rate for our content shape.
//
// 中: 服务端 delta 引擎 + 客户端 drift 校验共用的签名 + 哈希。算法
// 两边一致，delta 正确应用后客户端算出的 hash 跟服务端必相等；
// 不等说明 reducer 漂移。FNV-1a 32-bit，无 Node 依赖，浏览器也用。

import type { ChatFlow, ChatNode, WorkflowSummary } from "@/data/types";

/**
 * EN: stable signature of a WorkflowSummary's user-visible fields.
 * Same logic that drives the engine's diff-update emission. Excludes
 * variable-length payload (assistantPreview content, raw text) and
 * keeps just counts / flags that the cards / bubbles render.
 *
 * 中: WorkflowSummary 的稳定签名，跟 delta 引擎判更新用同一套字段。
 */
export function summarySig(s: WorkflowSummary | undefined): string {
  if (!s) return "no-summary";
  return [
    s.llmCount,
    s.assistantText.length,
    s.toolCount,
    s.hasInFlightWork ? "1" : "0",
    s.inputTokens,
    s.outputTokens,
    s.assistantPreview.length,
    s.lastModel ?? "",
    s.durationMs ?? 0,
  ].join("|");
}

/**
 * EN: stable signature of an entire ChatNode for hashing. Includes
 * structural identity (id / parent / root) + summarySig.
 *
 * 中: ChatNode 的稳定签名（结构 + summary）。
 */
export function chatNodeSig(cn: ChatNode): string {
  return [
    cn.id,
    cn.parentChatNodeId ?? "",
    cn.rootUserUuid,
    cn.isCompactSummary ? "1" : "0",
    summarySig(cn.workflow.summary),
  ].join("\t");
}

/**
 * EN: cheap per-canvas CONTENT digest — the dual of
 * `chatFlowLayoutSignature` (which is structure-only and deliberately
 * excludes content so 600-node dagre doesn't re-run on every
 * streaming token, see layoutDag.ts:234). ChatFlowCanvas's node memo
 * was gated SOLELY on the layout signature, so a content-only
 * `chatnode-summary-updated` delta updated the store but never
 * refreshed the card's `data.assistantPreview` — the card stayed
 * stale until the next topology change (next message) bumped the
 * layout signature. This digest changes whenever any card's rendered
 * content changes (per-node `summarySig`: assistantPreview/assistantText
 * length, llmCount, tokens, …) so the data-refresh memo can re-derive
 * card data cheaply (O(N) string + the existing pure deriveCardData)
 * WITHOUT calling dagre — preserving the #226 perf invariant exactly.
 *
 * 中: layout 指纹的对偶——内容指纹。layout 指纹故意不含内容（避免每
 * 个流式 token 全量 dagre），但 canvas 节点 memo 只盯 layout 指纹，
 * 导致 summary-updated delta 进了 store 却不刷新卡片，直到下一次拓扑
 * 变化才补上。本指纹随任意卡片渲染内容变化而变，让"只刷 data 不重
 * 排"的廉价 memo 能 O(N) 重算卡片数据，dagre 调用次数不变。
 */
export function chatFlowContentSignature(chatFlow: ChatFlow): string {
  const parts: string[] = [];
  for (const cn of chatFlow.chatNodes) {
    parts.push(cn.id + "|" + summarySig(cn.workflow.summary));
  }
  return parts.join("\n");
}

/**
 * EN: FNV-1a 32-bit hash over the sorted sig list. Sorting by id
 * ensures order-independence — useful because delta-added ChatNodes
 * append at the tail but a full GET returns them in BFS/closure
 * order. Both should yield the same hash for the same content.
 *
 * 中: FNV-1a 32-bit。先 sort 再 hash，让顺序不同但内容相同的
 * ChatNode 列表算出同一 hash。
 */
export function chatFlowHash(nodes: ChatNode[]): string {
  const sigs = nodes.map(chatNodeSig);
  sigs.sort();
  let h = 0x811c9dc5;
  for (const sig of sigs) {
    for (let i = 0; i < sig.length; i += 1) {
      h ^= sig.charCodeAt(i);
      h =
        (h +
          ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>>
        0;
    }
    // Separator between sigs so concatenation isn't ambiguous.
    // 中: sig 之间加分隔，防止 "ab" "" 跟 "a" "b" 撞 hash。
    h ^= 0x0a;
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

/**
 * EN: hash from pre-computed sigs (server uses this — snapshot has
 * signatures cached already, no need to re-stringify ChatNodes).
 *
 * 中: 已有 sig 字符串数组时直接 hash，省一遍 chatNodeSig。
 */
export function hashFromSigs(sigs: string[]): string {
  const sorted = [...sigs].sort();
  let h = 0x811c9dc5;
  for (const sig of sorted) {
    for (let i = 0; i < sig.length; i += 1) {
      h ^= sig.charCodeAt(i);
      h =
        (h +
          ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>>
        0;
    }
    h ^= 0x0a;
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}
