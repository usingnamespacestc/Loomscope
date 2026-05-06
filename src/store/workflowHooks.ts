// EN: Component-level workflow access hook. Centralises three things
// any DrillPanel / WorkFlowCanvas consumer would otherwise repeat:
//   (1) Distinguishing inline-loaded workflows (sub-agent ChatFlow,
//       eager fixtures, ?full=true responses) from the lite shape
//       served by the default endpoint.
//   (2) Triggering `loadChatNodeWorkflows` for lite ChatNodes whose
//       workflow hasn't been fetched yet — fire-and-forget; subscribers
//       re-render when the cache entry flips to `ready`.
//   (3) Returning a uniform `{ workflow, status, error, isLazy }`
//       shape so every consumer shares one skeleton / ready / error
//       state machine.
//
// ⚠ IMPORTANT (v0.9.1 fix): inline workflow.nodes WINS over
// workflowCache when populated. workflowCache is keyed by chatNode.id;
// CC's Task delegation reuses the parent's user uuid as the sub-
// agent jsonl's first user record uuid → top-level and sub-agent
// ChatNodes routinely share id. Letting cache win for the collision
// case rendered the WRONG WorkFlow (top-level's) when the consumer
// asked for sub-agent's. The /subagents endpoint always returns
// full-fat ChatFlows (inline non-empty), and lite top-level always
// has empty inline — these two states are mutually exclusive, so
// "inline non-empty ⇒ sub-agent path" is a reliable scope signal.
//
// 中: 组件层 workflow 读取 hook，封装三个共性逻辑：
//   (1) 区分 inline-loaded（sub-agent / 测试 fixture）和 lite endpoint
//       的精简响应；
//   (2) lite ChatNode 第一次访问时 fire-and-forget 调
//       `loadChatNodeWorkflows`；
//   (3) 给所有消费者返回统一的 `{ workflow, status, error, isLazy }`。
//
// ⚠ v0.9.1 关键修复：inline workflow.nodes 优先于 cache。workflowCache
// 用 chatNode.id 当 key，但 CC delegate 派发让 sub-agent 第一条
// user record 复用 parent uuid → sub-agent 跟 parent ChatNode 共享 id。
// 让 cache 赢的话，sub-agent 的 ChatNode 会拉到 top-level 的 cache 渲
// 染错的 WorkFlow。`/subagents` 永远返 full-fat（inline 非空），lite
// top-level 永远 inline 为空 —— 这两个状态互斥，"inline 非空 ⇒
// sub-agent 路径"是可靠 signal。

import { useEffect } from "react";

import type { ChatNode, WorkFlow } from "@/data/types";
import { useStore } from "@/store/index";

export type WorkflowAccessStatus = "ready" | "pending" | "error";

export interface WorkflowAccessResult {
  /** Populated WorkFlow when status === "ready"; null otherwise. */
  workflow: WorkFlow | null;
  status: WorkflowAccessStatus;
  /** Set when status === "error". Plain message — no stack. */
  error: string | null;
  /** True when this access went through the lazy cache. False when
   * the inline workflow.nodes was already populated (sub-agent /
   * eager test fixture / ?full=true response). Useful for debugging
   * but not normally consumed. */
  isLazy: boolean;
}

export interface UseChatNodeWorkflowOpts {
  /** When false, the hook becomes a pure read — it will NOT fire
   * `loadChatNodeWorkflows` on first access. Caller takes ownership
   * of triggering the fetch (e.g. ConversationView's progressive
   * reveal staggers fetches itself, and would otherwise see all
   * children-hook autoFetches collapse into one batch via the
   * microtask coalescing buffer in `loadChatNodeWorkflows`). Default
   * true preserves the v0.10 behaviour for every other call site. */
  autoFetch?: boolean;
}

/**
 * Return the WorkFlow object for a ChatNode, lazy-loading on first
 * access. Safe to call from a component render; the load fires from
 * a useEffect under the hood (unless `opts.autoFetch === false`).
 */
export function useChatNodeWorkflow(
  sessionId: string,
  chatNode: ChatNode,
  opts: UseChatNodeWorkflowOpts = {},
): WorkflowAccessResult {
  const autoFetch = opts.autoFetch !== false;
  const cached = useStore((s) =>
    s.sessions.get(sessionId)?.workflowCache.get(chatNode.id) ?? null,
  );
  const load = useStore((s) => s.loadChatNodeWorkflows);

  const inlineLoaded = chatNode.workflow.nodes.length > 0;
  const summary = chatNode.workflow.summary;
  const summaryHasContent =
    !!summary && (summary.llmCount > 0 || summary.toolCount > 0);
  // Lite ChatNode that genuinely has content the canvas card hinted
  // at — needs lazy fetch. ``nodes.length === 0`` ALONE isn't
  // enough: a slash-only / compact-only turn legitimately has empty
  // workflow.nodes and shouldn't trigger a fetch.
  const needsLazy = !inlineLoaded && summaryHasContent;

  useEffect(() => {
    if (!autoFetch) return;
    if (!needsLazy) return;
    // EN: refetch decision tree.
    //   - pending: someone else's fetch in flight, wait for it
    //   - ready + NOT stale: cache is current, no need
    //   - ready + stale: refreshSession marked it stale because the
    //     ChatNode summary shifted (typically the running node grew
    //     a tool_use); we MUST refetch or the cached (often empty)
    //     workflow stays visible forever — the original bug that
    //     made drill view show "没有 WorkFlow 节点" indefinitely
    //     during live updates after first being drilled into while
    //     the summary was still 0/0.
    //   - error / undefined: first access OR retry
    // 中: 关键修复 —— ready 但 stale 时必须重 fetch，否则 cache 早期
    // 抓到的空 workflow 会永远停在 drill 视图里。原 bug：drill 一个
    // 还在跑的 ChatNode 时 cache 拿到 `{nodes:[], edges:[]}`，之后
    // summary 长大但 workflowCache 保持 stale-ready 状态显示空。
    if (cached?.status === "pending") return;
    if (cached?.status === "ready" && !cached.staleSince) return;
    void load(sessionId, [chatNode.id]);
  }, [
    autoFetch,
    needsLazy,
    cached?.status,
    cached?.staleSince,
    load,
    sessionId,
    chatNode.id,
  ]);

  // Resolution priority: INLINE WINS when the workflow is already
  // populated. Why: workflowCache is keyed by chatNode.id, and CC's
  // Task delegation reuses parent user uuids as the sub-agent jsonl's
  // first user record uuid → top-level and sub-agent ChatNodes
  // routinely share ids. If we let cache win for an id-collision case,
  // we'd render the WRONG WorkFlow (top-level's) when chatNode is
  // sub-agent's. Inline-populated chatNodes ALWAYS come from the
  // /subagents path (full-fat) so trusting inline over cache is
  // correct for sub-agent ChatNodes. For lite top-level ChatNodes,
  // inlineLoaded is false (lite strips nodes) so we still fall
  // through to cache.
  if (inlineLoaded) {
    return {
      workflow: chatNode.workflow,
      status: "ready",
      error: null,
      isLazy: false,
    };
  }
  if (cached?.status === "ready" && cached.workflow) {
    return {
      workflow: cached.workflow,
      status: "ready",
      error: null,
      isLazy: true,
    };
  }
  // EN: stale-while-revalidate — when refreshSession marked an entry
  // as pending+stale (kept the old workflow as a placeholder), show
  // the old workflow as ready so the bubble doesn't visually shrink
  // to summary.assistantPreview during the 50-100ms refetch window.
  // Once the fetch lands, the new entry is status:ready + workflow
  // updated; this branch stops matching.
  // 中: stale-while-revalidate —— refreshSession 把 entry 标 pending
  // 但保留旧 workflow 作占位时，本路径让 hook 把旧 workflow 当 ready
  // 显示，避免气泡瞬间压缩成一行预览。fetch 完成后自动切换。
  if (cached?.status === "pending" && cached.workflow) {
    return {
      workflow: cached.workflow,
      status: "ready",
      error: null,
      isLazy: true,
    };
  }
  if (cached?.status === "error") {
    return {
      workflow: null,
      status: "error",
      error: cached.error,
      isLazy: true,
    };
  }
  if (!summaryHasContent) {
    // Empty turn (slash-only / compact-only) — return inline empty
    // workflow as ready so consumers don't render a permanent
    // skeleton.
    return {
      workflow: chatNode.workflow,
      status: "ready",
      error: null,
      isLazy: false,
    };
  }
  return {
    workflow: null,
    status: "pending",
    error: null,
    isLazy: true,
  };
}
