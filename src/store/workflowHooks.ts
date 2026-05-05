// Component-level workflow access hook. Centralises three concerns
// that any DrillPanel / WorkFlowCanvas consumer would otherwise have
// to repeat:
//
//   1. Distinguishing inline-loaded workflows (sub-agent ChatFlow,
//      eager fixtures, ?full=true responses) from the lite shape that
//      the default endpoint serves.
//   2. Triggering `loadChatNodeWorkflows` when a lite ChatNode's
//      workflow hasn't been fetched yet — fire-and-forget; subscribers
//      re-render when the cache entry flips to `ready`.
//   3. Returning a uniform `{ workflow, status, error }` shape so
//      every consumer gets the same skeleton / ready / error state
//      machine without duplicating lookup logic.
//
// Top-level vs sub-agent ChatNode discriminator: we don't need an
// explicit flag. Top-level ChatNodes arrive via the lite endpoint,
// so their `workflow.nodes` is `[]` while `workflow.summary` is
// populated. Sub-agent ChatFlows ship through `loadSubAgent` which
// returns full workflow.nodes inline. So `nodes.length > 0` ⇒
// already-loaded; only the (length === 0 && summary indicates content)
// case triggers lazy load.

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

/**
 * Return the WorkFlow object for a ChatNode, lazy-loading on first
 * access. Safe to call from a component render; the load fires from
 * a useEffect under the hood.
 */
export function useChatNodeWorkflow(
  sessionId: string,
  chatNode: ChatNode,
): WorkflowAccessResult {
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
    if (!needsLazy) return;
    if (cached?.status === "ready" || cached?.status === "pending") return;
    // First access OR previous error — fire (re)load. Action dedupes
    // against in-flight, so concurrent hooks for the same id collapse
    // into one network round-trip.
    void load(sessionId, [chatNode.id]);
  }, [needsLazy, cached?.status, load, sessionId, chatNode.id]);

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
